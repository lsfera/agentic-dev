# /hitl is a merge gate only, sharing /afk's event path

`/hitl` places its sole human checkpoint at the PR merge. The agent runs autonomously to a PR exactly as in `/afk`; the only difference is that the PR does not auto-merge — the human reviews the diff and merges in GitHub.

Because the merge is the queue-advancing event (ADR-0008), `/afk` and `/hitl` ride the **same** PR-merged webhook and differ only in *who* merges (CI-driven auto-merge vs human click). There is no separate human-in-the-loop machinery.

## Why not a pre-start or plan gate

- A pre-start gate largely re-approves the `ready-for-agent` triage, which already encodes human blessing from `/grill` → `/to-issues`.
- A plan gate would force the listener to wait on a human *mid-sandbox*, adding a second checkpoint type and interactive complexity. The PR diff is the higher-value, GitHub-native review surface.

## Consequences

- `/afk` and `/hitl` are one pipeline with a single swappable merge step — minimal divergence to maintain.
- The human can still reject by closing the PR; the orchestrator treats an unmerged/closed PR as "issue not done" and does not unblock dependents.
