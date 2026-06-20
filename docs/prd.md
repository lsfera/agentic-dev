# PRD: Sandcastle-based `/afk` orchestrator

## Problem Statement

Today `/afk` drives autonomous implementation by spawning host-side sub-agents (the Agent tool), one per `ready-for-agent` GitHub issue, each shelling into the single shared outer devcontainer via `/exec`. All agents share one container and one working tree: they can collide, there is no true per-issue isolation, and the human running `/afk` is tied up because the loop lives in their Claude session. The user wants to run many issues autonomously, each in a disposable, isolated environment, on either their Claude subscription or a free local model, without their host Claude session being the engine.

## Solution

Replace the host-sub-agent engine of `/afk` with an **orchestrator** (the sandcastle library) running inside the outer devcontainer. For each `ready-for-agent` issue the orchestrator spins a disposable **agentic sandbox**, runs a coding agent there **git-isolated** (its own checkout, commits to a named branch), opens a pull request, and lets the dependency graph drive the queue. `/afk` auto-merges each PR on green CI; `/hitl` waits for a human merge. The user keeps the same commands (`/grill-me-with-docs` → `/to-prd` → `/to-issues` → `/afk`/`/hitl`) and the same GitHub-issues-as-durable-state model — only the execution engine changes.

## User Stories

1. As a developer, I want `/afk` to process every `ready-for-agent` issue without my input, so that a backlog clears unattended.
2. As a developer, I want each issue worked in its own disposable agentic sandbox, so that concurrent or sequential issues never collide on a shared working tree.
3. As a developer, I want each agent to commit to its own branch and open a PR, so that I get a reviewable unit of work per issue.
4. As a developer, I want dependent issues to become `ready-for-agent` only after their blockers' PRs merge, so that work proceeds in dependency order.
5. As a developer, I want `/afk` to auto-merge a PR once its CI is green, so that a multi-layer dependency graph clears in a single run.
6. As a developer, I want `/hitl` to behave identically except that I merge each PR myself, so that I can review before anything lands.
7. As a developer, I want to reject an agent's work by closing its PR, so that the orchestrator leaves dependents blocked and moves on.
8. As a developer, I want the orchestrator to run one agentic sandbox at a time by default, so that I stay within a single Claude subscription seat's limits.
9. As a developer, I want to raise concurrency per run when I have headroom, so that independent issues can run in parallel.
10. As a developer, I want to choose the agent model per run (Claude subscription or a local Ollama model), so that I can route cheap/mechanical issues to the free local tier.
11. As a developer, I want the orchestrator to authenticate the agent with my Claude subscription via `CLAUDE_CODE_OAUTH_TOKEN`, so that I do not need an Anthropic API key.
12. As a developer, I want agentic sandboxes to push over my existing SSH key, so that I reuse the auth the devcontainer already mounts.
13. As a developer, I want the orchestrator to react to GitHub `PR merged` events, so that dependents unblock and the next sandbox starts promptly.
14. As a developer, I want the orchestrator to recover missed webhook deliveries by re-deriving the queue from live GitHub state, so that a dropped event never stalls the run.
15. As a developer, I want the orchestrator to stop cleanly when no issue is ready and no PR is in flight, so that an `/afk` run terminates.
16. As a developer, I want each agentic sandbox torn down after its run, so that disposable containers do not accumulate on my host.
17. As a developer, I want orphaned sandboxes from a crashed run swept on the next startup, so that a failed run leaves no dangling containers.
18. As a developer, I want the orchestrator to run from the path-matched mount, so that git-isolated worktrees resolve under docker-outside-of-docker.
19. As a developer, I want `/afk` to remain a thin command that launches the orchestrator, so that the command surface and GitHub-issues queue are unchanged.
20. As a developer, I want each agent constrained to its issue's scope (no pushing to main, no unrelated edits, no new dependencies), so that PRs stay reviewable and safe.
21. As a developer, I want an agent to stop as soon as its task is done (via a completion signal), so that it does not loop and produce duplicate commits.
22. As a developer, I want the orchestrator to log each run, so that I can inspect what each agent did.
23. As a developer, I want to point the local tier at my Ollama server reachable from the sandbox, so that the agent can use a local coding model.
24. As a maintainer, I want the orchestration logic tested in isolation from Docker/GitHub, so that I can trust the queue/merge/unblock behavior without slow end-to-end runs.
25. As a maintainer, I want one integration test that really spins a sandbox and asserts a commit, so that the sandcastle round-trip stays proven over time.
26. As a developer, I want a webhook secret validated and merge events de-duplicated, so that a replayed or duplicate delivery cannot start a sandbox twice.
27. As a developer, I want toolchain-heavy projects to define their own inner image, so that the agent has the project's tools while trivial projects use the lean default.

## Implementation Decisions

- **Engine swap, not workflow change (ADR-0005, ADR-0006).** `/grill-me-with-docs` → `/to-prd` → `/to-issues` and GitHub-issues-as-durable-state are unchanged. `/afk` becomes a thin wrapper that `/exec`s the orchestrator; the orchestrator's `main.ts` is the new engine.
- **Run from the path-matched mount (ADR-0011, implemented).** The orchestrator's working directory is `${LOCAL_WORKSPACE_FOLDER}` (the host-path mirror mount), not `/workspaces/<folder>`, so sandcastle's worktrees carry host-resolvable paths under docker-outside-of-docker.
- **Git-isolated execution (ADR-0001).** Sandcastle's `branch` strategy: each agentic sandbox gets its own checkout and commits to a named branch (e.g. `agent/issue-<N>`), pushed back. Confirmed that sandcastle bind-mounts the worktree, hence the path-match requirement.
- **Pure orchestration core.** A single pure reducer holds all decision logic. Shape (from the design):
  ```
  reduce(state, event) -> Action[]
    state  = { issues: {id, labels, blockedBy[]}[], prs: {issue, ciStatus, merged}[], policy: {concurrency, mode} }
    event  = Tick | PrMerged(pr) | SandboxFinished(issue, pr) | SandboxFailed(issue)
    Action = StartSandbox(issueId) | EnableAutoMerge(pr) | Relabel(issueId, label)
           | WaitForHuman(pr) | Stop
  ```
  The reducer never performs I/O. It computes the ready-set from issues + merged PRs, respects the concurrency policy, gates merge by mode, and emits `Stop` when nothing is ready and no PR is in flight.
- **Thin adapters driven by actions.** `IssueSource` (GitHub via `gh`: list/label/comment, PR create/merge), `SandboxRunner` (wraps sandcastle `run()`), `EventBridge` (smee → reducer events). Adapters carry no decision logic.
- **Concurrency is a per-run knob, default serial (ADR-0003).** The reducer emits at most `policy.concurrency` concurrent `StartSandbox` actions; default 1.
- **Auto-merge vs HITL (ADR-0007, ADR-0009).** `/afk` emits `EnableAutoMerge(pr)` (GitHub-native `gh pr merge --auto`), gating entirely on required CI checks. `/hitl` emits `WaitForHuman(pr)` instead. Both advance via the same `PrMerged` event; the only difference is who merges. A closed-unmerged PR leaves dependents blocked.
- **Event-driven with a reconciliation backstop (ADR-0008).** The orchestrator is a persistent listener fed by a smee channel relaying GitHub `pull_request` events. On startup and periodically it re-derives the ready-set from live GitHub state so missed deliveries cannot stall it. Webhook payloads are HMAC-validated; merge events are de-duplicated by PR number / merge SHA so a sandbox never starts twice.
- **Agent backend is a pluggable per-run tier (ADR-0003).** Default tier is Claude via `claudeCode`, authenticated by `CLAUDE_CODE_OAUTH_TOKEN` injected from `.sandcastle/.env` (no API key). A local tier uses `opencode` pointed at the host Ollama server (`host.docker.internal:11434`, OpenAI-compatible) via an `opencode.json` provider block copied into the worktree; the inner image must contain the chosen CLI.
- **Inner image (ADR-0002).** Lean sandcastle default (Node + git + gh + the agent CLI) for JS/TS; toolchain-heavy projects derive their own `.sandcastle/Dockerfile`. The OpenCode local-tier image is a separate variant.
- **Git push auth (ADR-0004).** Agentic sandboxes push using the host SSH key mounted read-only; safe under the default-serial policy (one key copy live at a time).
- **Completion signal required.** Each `run()` passes a `completionSignal` (and bounded `maxIterations`) so an agent stops when done instead of looping and producing duplicate commits (observed in the spike).
- **Scope guardrails preserved.** The per-issue agent prompt keeps the existing guardrails: only files the issue requires, no pushing to main, no closing other issues, no new dependencies; finish by committing to the branch, commenting the issue, opening the PR.
- **Sandbox lifecycle (ADR-0010).** Each run closes its sandbox in a `finally`; inner sandboxes are labeled and the orchestrator runs a label-scoped teardown sweep on startup/shutdown to remove orphans.

## Testing Decisions

- **What a good test asserts here:** external behavior of the orchestration core — given a world-state and an event, the *set of emitted actions* — not internal structure. Tests must not assert call order of adapters, private helpers, or sandcastle internals.
- **Primary seam — the pure reducer (unit, exhaustive).** `reduce(state, event) → Action[]`, tested with constructed states/events, no Docker/GitHub/network. Cases to cover: empty queue → `Stop`; one ready issue under serial policy → exactly one `StartSandbox`; concurrency=N → at most N `StartSandbox`; `PrMerged` unblocks only issues whose *all* blockers are merged; `/afk` mode emits `EnableAutoMerge`, `/hitl` emits `WaitForHuman`; closed-unmerged PR leaves dependents blocked; duplicate `PrMerged` for an already-processed PR emits no new `StartSandbox`; nothing ready but PRs in flight → no `Stop` (keep listening).
- **Secondary seam — sandbox round-trip (one integration test).** A single, hardened Beat-1/2-style test that actually runs one sandcastle sandbox against the path-matched mount and asserts a commit lands on the expected branch. Guards the real round-trip (worktree resolves under DooD, agent commits). Marked slow / Docker-required so it can be excluded from the fast unit run. Prior art: the `ws/skeleton-spike` harness (`beat1-main.ts` hook-based, `beat2-main.ts` agent-based) that proved ADR-0001/0003/0011.
- **Adapters** get light integration coverage only (e.g. `IssueSource` parses `Blocked by #N` and label state correctly); their decision-free nature means most confidence comes from the reducer tests.

## Out of Scope

- Changing the upstream workflow commands (`/grill-me-with-docs`, `/to-prd`, `/to-issues`) beyond what the engine swap requires.
- Multi-context / multi-repo orchestration in one run — one target repo per `/afk` run.
- Non-GitHub issue trackers; GitHub issues remain the single source of truth for this repo.
- Replacing docker-outside-of-docker with docker-in-docker or rootless podman (path-match already resolves the trap).
- A hosted/always-on webhook endpoint; smee (a local relay) is the bridge for a single-seat dev setup.
- Benchmarking or auto-selecting local models; model/tier is a manual per-run knob.
- Auto-tuning concurrency; it is a manual per-run knob, default serial.

## Further Notes

- Validated in this design cycle (walking skeleton, see `docs/adr/` and `ws/skeleton-spike/SPIKE.md`): ADR-0011 path-match (green in the real devcontainer), ADR-0003 subscription auth via `CLAUDE_CODE_OAUTH_TOKEN` (green), and the local Ollama tier via `opencode` + `qwen3-coder:30b` (green). The smee event loop (ADR-0008) is the one piece not yet spiked end-to-end.
- Sandcastle API facts that shaped this: `createSandbox()` returns `{ branch, worktreePath, run, interactive, close }` (no raw `exec` — drive shell via a sandbox hook or an agent `run`); untracked config (e.g. `opencode.json`) must be carried in via `copyToWorktree`; the inner image must be built for UID 1000.
- Local Ollama is the user's M4 Max / 64 GB host on `0.0.0.0:11434`; keep model weights ~15–22 GB to leave headroom for the container stack.
