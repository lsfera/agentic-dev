# `/afk` merge policy: AI review gate, then auto-merge on green CI

**Status:** Accepted. Absorbs the former ADR-0007.

In `/afk` mode, after the implementing sandbox opens a PR, a **reviewer sandbox** runs before auto-merge is enabled. The reviewer reads the diff against the issue's acceptance criteria and ADR conventions and emits a structured `pass | changes-requested` verdict. Only a `pass` verdict proceeds to auto-merge; `changes-requested` parks the PR for a human, with the review posted directly to the PR.

Auto-merge itself — `/afk` merges each PR once CI is green so a multi-layer dependency graph can clear in one autonomous run, while `/hitl` keeps a human merge gate — was originally decided with CI as the only safety net. This ADR absorbs that decision (the former ADR-0020, removed) and adds the review gate in front of it: CI remains required but is no longer the *only* gate.

## Auto-merge (original decision)

- **Hard requirement:** every project run under `/afk` must have meaningful, *required* status checks and branch protection, so auto-merge gates on something real. Without trustworthy CI, `/afk` merges unreviewed code.
- **Mechanism:** GitHub-native auto-merge (`gh pr merge --auto`); the orchestrator enables it rather than polling CI and merging itself.
- **Consequences:** truly hands-off multi-layer runs, bounded by required CI and serial execution (ADR-0003). Because auto-merge completes asynchronously, the orchestrator reconciles with merges that land after the sandbox has closed (ADR-0008). A bad early merge can cascade into dependents; serial execution limits the blast radius to one issue.

## `/hitl`: a merge gate only, sharing `/afk`'s event path

`/hitl` places its sole human checkpoint at the PR merge. The agent runs autonomously to a PR exactly as in `/afk`; the PR just does not auto-merge — the human reviews the diff and merges in GitHub. Because the merge is the queue-advancing event (ADR-0008), `/afk` and `/hitl` ride the **same** PR-merged webhook and differ only in *who* merges (CI-driven auto-merge vs human click). There is no separate human-in-the-loop machinery: one pipeline, one swappable merge step.

- **Why not a pre-start gate:** it largely re-approves the `ready-for-agent` triage, which already encodes human blessing from `/grill` → `/to-issues`.
- **Why not a plan gate:** it would force the listener to wait on a human mid-sandbox, adding a second checkpoint type and interactive complexity. The PR diff is the higher-value, GitHub-native review surface.
- **Rejection:** the human can close the PR; the orchestrator treats an unmerged/closed PR as "issue not done" and does not unblock dependents.

## Review gate: motivation

CI catches regressions and type errors but cannot verify that the implementation actually satisfies the acceptance criteria stated in the issue. Off-spec-but-CI-green code was silently merging under `/afk`. The reviewer catches that gap without requiring a human in the loop on every issue.

## Review gate: design

- **Two-pass produce→extract pattern:** Pass 1 (`review-prompt.md`) — the agent reads the diff + ADRs + criteria and forms a free-form review. Pass 2 (`review-extraction.md`) resumes the same session and emits a single `<output>{…}</output>` block with the JSON verdict. Structured output is validated via `Output.object({ tag, schema })` (no hand-rolled regex).
- **Schema:** `{ verdict: "pass" | "changes-requested", summary, comments[] }`. Each comment carries `path`, `line` (new-file line number), and `body`.
- **Validate then filter:** inline comments are filtered through `parseDiffLines` / `filterInlineComments` before being posted, so off-diff line references (hallucinated or stale) are never sent to the API.
- **Reviewer runs in `noSandbox()`** — read-only; never pushes or commits.
- **Fail-safe:** any reviewer timeout, crash, or garbled verdict resolves to `changes-requested` via `reviewVerdict()`, so a reviewer failure never silently auto-merges.
- **Reducer gate:** `onSandboxFinished` in `reduce.ts` returns `StartReview { pr }` (not `EnableAutoMerge`) in afk mode. A new `ReviewFinished { issue, pr, verdict }` event maps `pass → EnableAutoMerge`, `changes-requested → WaitForHuman`. `/hitl` is unchanged — `onSandboxFinished` still returns `WaitForHuman` (the human is the reviewer, see `/hitl` below).

## Review gate: consequences

- `/afk` now requires a Claude seat for the reviewer sandbox on every issue, in addition to the implementing sandbox. This is bounded to one issue at a time (serial execution, ADR-0003).
- A reviewer crash or timeout is safe (changes-requested) but delays the issue; a human must re-label and re-run.
- `/hitl` is completely unaffected — the human is still the sole reviewer there.
- Human-driven `/code-review ultra` remains available as an alternative but cannot run hands-off; it is not integrated into the autonomous loop.
- The downstream merge mechanism (GitHub-native auto-merge on green CI) is unchanged — this only inserts a gate before `EnableAutoMerge` is called.
