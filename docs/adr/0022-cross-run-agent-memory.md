# Cross-run agent memory

A hand-rolled, GitHub-issue-backed memory store gives each `/afk` run access to facts learned by *previous* runs against the same repo: project conventions, gotchas an agent hit, and outcome history for issues that needed more than one attempt. Storage is a single pinned issue per repo, auto-created on first write, labelled `agent:memory`. Retrieval is category-filtered and injected into the implementing agent's prompt via `{{MEMORY_CONTEXT}}`.

## Motivation

Two related gaps, both already implicit elsewhere in this codebase:

- CLAUDE.md's retry-semantics section documents a known limitation: "attempt counts live in the orchestrator's in-run state and reset when the orchestrator restarts... cross-run persistence is not implemented." The `outcome` category here is that missing persistence layer.
- An agent working issue N today has no way to know what an agent working issue N-1 discovered about this repo — a repeated gotcha (e.g. #48's MTU black-hole) or a convention worth following gets rediscovered, or missed, every single run.

## Why not headroom-ai's Memory or SharedContext products

headroom-ai ships two products that look adjacent to this need, evaluated and rejected:

- **SharedContext** — a TS class for agent-to-agent handoff compression within a single workflow run. Not applicable: this repo's agents don't hand off context to each other mid-run: each sandbox is independent and the gap is *across* runs, not *within* one.
- **Memory** (`with_memory(OpenAI(), user_id=...)`) — the product this feature is inspired by (category split, temporal supersession), but it is Python-only with no JS API, and the TypeScript SDK note on headroom's own docs says compression is proxied through a hosted backend. Neither fits a Node orchestrator that wants durable state it fully owns.

## Design

- **Storage:** a single GitHub issue per repo, title `"Agent memory (do not close)"`, labelled `agent:memory`. Auto-created on first write if absent (`findIssueByLabel` → `createIssue`) — no human setup step, consistent with "GitHub issues are the durable state" (CLAUDE.md). A create-race producing two labelled issues is resolved by convention, not locking: the lowest-numbered issue is always canonical; the orchestrator warns and moves on (fail-open, not blocking).
- **Categories (exactly three, no more):** `repo-convention` (agent-emitted, always injected in full), `gotcha` (agent-emitted, capped at last 5), `outcome` (orchestrator-emitted, one entry per issue posted at terminal state, capped at last 5). No `preference`/`decision` category — those overlap with ADRs/CLAUDE.md, which already own that role.
- **Comment format:** structured-but-human-readable markdown — an `<!-- agentic-memory -->` marker, `**Field:**` key lines, then free-text body. Mirrors this assistant's own memory-file convention (frontmatter + body). Not raw JSON (hard to skim on the issue), not pure prose (hard to parse reliably).
- **Agent emission:** piggybacks on the existing, already-proven `COMPLETION_SIGNAL` regex-scan in `sandbox-runner.ts` — an agent optionally emits `<repo-convention>...</repo-convention>` or `<gotcha>...</gotcha>` in its final turn, scanned out of `SandboxRunResult.stdout` after the run. Fixed tag names rather than a `category` attribute, so an unrecognized category is a syntax-level impossibility, not a runtime validation branch. No resume call, no `Output.object()` schema, no second sandcastle pass — this exact machinery is what caused issue #82's crash, and this feature deliberately avoids it.
- **Orchestrator emission (`outcome`):** posted once per issue at terminal state — `EnableAutoMerge` (review passed) for success, or the existing retries-exhausted `Comment` action (`SandboxFailed` branch) for failure — accumulating the full attempt history into one comment (`Result`, `Attempts`, `PR` fields + one free-text line per attempt). Not posted per-attempt (would crowd the last-N window) and not gated on the literal async `PrMerged` webhook (that path has no visibility into per-issue attempt counts and re-wiring it for this would be disproportionate plumbing).
- **Retrieval scope:** the implementing agent only. The reviewer does not receive `MEMORY_CONTEXT` — priming a fail-safe reviewer with "past attempts on similar issues struggled" risks biasing its verdict on a dimension unrelated to whether *this* diff is correct.
- **Failure semantics:** fail-open everywhere. A read failure (memory issue missing, `gh` blip) degrades to no memory context, not a blocked run. A write failure is logged and swallowed, never counted against `SandboxFailed`'s retry budget — memory is an optimization, not a correctness gate.
- **Dedup:** none, initially. Repeated `gotcha`/`repo-convention` entries are tolerated rather than fuzzy-matched against existing ones at write or read time; `repo-convention`'s uncapped injection makes duplication merely redundant, not lossy. Add dedup only if repetition proves to be a real problem once this runs against real repos.

## Consequences

- Every `/afk` implementation run now costs one extra `gh issue view --json comments` read (retrieval) and, best-effort, one or more `gh issue comment` writes — bounded, not on the critical path (fail-open).
- The pinned memory issue accumulates comments indefinitely; nothing prunes it beyond the last-N retrieval cap. If comment volume ever becomes a problem, dedup or archival is the follow-up, not a v1 concern.
- `SandboxOutcome` now exposes raw `stdout`, and `buildAgentInput` takes an extra `memoryContext` parameter — both are caller-supplied, keeping `sandbox-runner.ts` free of any GitHub I/O (that stays in `issue-source.ts` / `memory-store.ts`, matching the existing pure-reducer/impure-adapter split).
