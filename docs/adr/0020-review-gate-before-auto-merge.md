# AI review gate before auto-merge in /afk

In `/afk` mode, after the implementing sandbox opens a PR, a **reviewer sandbox** runs before auto-merge is enabled. The reviewer reads the diff against the issue's acceptance criteria and ADR conventions and emits a structured `pass | changes-requested` verdict. Only a `pass` verdict proceeds to auto-merge; `changes-requested` parks the PR for a human, with the review posted directly to the PR.

This amends ADR-0007 ("CI is the only safety net"): CI remains required but is no longer the *only* gate — an AI review step now precedes it.

## Motivation

CI catches regressions and type errors but cannot verify that the implementation actually satisfies the acceptance criteria stated in the issue. Off-spec-but-CI-green code was silently merging under `/afk`. The reviewer catches that gap without requiring a human in the loop on every issue.

## Design

- **Two-pass produce→extract pattern:** Pass 1 (`review-prompt.md`) — the agent reads the diff + ADRs + criteria and forms a free-form review. Pass 2 (`review-extraction.md`) resumes the same session and emits a single `<output>{…}</output>` block with the JSON verdict. Structured output is validated via `Output.object({ tag, schema })` (no hand-rolled regex).
- **Schema:** `{ verdict: "pass" | "changes-requested", summary, comments[] }`. Each comment carries `path`, `line` (new-file line number), and `body`.
- **Validate then filter:** inline comments are filtered through `parseDiffLines` / `filterInlineComments` before being posted, so off-diff line references (hallucinated or stale) are never sent to the API.
- **Reviewer runs in `noSandbox()`** — read-only; never pushes or commits.
- **Fail-safe:** any reviewer timeout, crash, or garbled verdict resolves to `changes-requested` via `reviewVerdict()`, so a reviewer failure never silently auto-merges.
- **Reducer gate:** `onSandboxFinished` in `reduce.ts` returns `StartReview { pr }` (not `EnableAutoMerge`) in afk mode. A new `ReviewFinished { issue, pr, verdict }` event maps `pass → EnableAutoMerge`, `changes-requested → WaitForHuman`. `/hitl` is unchanged — `onSandboxFinished` still returns `WaitForHuman` (the human is the reviewer, ADR-0009).

## Consequences

- `/afk` now requires a Claude seat for the reviewer sandbox on every issue, in addition to the implementing sandbox. This is bounded to one issue at a time (serial execution, ADR-0003).
- A reviewer crash or timeout is safe (changes-requested) but delays the issue; a human must re-label and re-run.
- `/hitl` is completely unaffected — the human is still the sole reviewer there (ADR-0009).
- Human-driven `/code-review ultra` remains available as an alternative but cannot run hands-off; it is not integrated into the autonomous loop.
- The downstream merge mechanism (GitHub-native auto-merge on green CI) is unchanged — this only inserts a gate before `EnableAutoMerge` is called.
