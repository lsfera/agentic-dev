# Sandcastle replaces /afk; GitHub issues stay the durable queue

agentic.dev and sandcastle overlap only on the *executor* half, not the *work-definition* half. We keep agentic.dev's definition pipeline — `/grill` → `/to-prd` → `/to-issues`, producing GitHub issues as vertical slices, with issues as the durable state — and replace the `/afk` executor with sandcastle's orchestrator running inside the outer devcontainer.

The orchestrator (`.sandcastle/main.ts`) reads `ready-for-agent` issues, spins one inner agentic sandbox per issue, the agent works git-isolated (ADR-0001), commits to a branch and pushes / opens a PR, and dependents are relabeled as they unblock.

## Consequences

- Each tool keeps its strongest half: agentic.dev slices work into a durable, triageable queue; sandcastle runs the sandboxed, git-isolated execution.
- Sandcastle's own issue-tracker integration is **not** used — GitHub issues remain the single source of truth.
- `/hitl` (the reviewed variant of `/afk`) still needs a mapping onto this model — see later ADRs.
