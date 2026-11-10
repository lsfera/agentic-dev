# Sandcastle replaces /afk, launched via /exec; GitHub issues stay the durable queue

**Status:** Accepted. Absorbs the former ADR-0006. Implementation style superseded by ADR-0028.

agentic.dev and sandcastle overlap only on the *executor* half, not the *work-definition* half. We keep agentic.dev's definition pipeline — `/grill` → `/to-prd` → `/to-issues`, producing GitHub issues as vertical slices, with issues as the durable state — and replace the `/afk` executor with sandcastle's orchestrator running inside the outer devcontainer.

The orchestrator (`.sandcastle/src/main.ts`) reads `ready-for-agent` issues, spins one inner agentic sandbox per issue, the agent works git-isolated (ADR-0001), commits to a branch and pushes / opens a PR, and dependents are relabeled as they unblock.

## Consequences

- Each tool keeps its strongest half: agentic.dev slices work into a durable, triageable queue; sandcastle runs the sandboxed, git-isolated execution.
- Sandcastle's own issue-tracker integration is **not** used — GitHub issues remain the single source of truth.
- `/hitl` (the reviewed variant of `/afk`) still needs a mapping onto this model — see later ADRs.

## Launch: `/afk` is a thin wrapper that `/exec`s the orchestrator

The orchestrator runs inside the outer devcontainer, so something must launch it. `/afk` keeps its user-facing meaning ("run the ready-for-agent queue") but is implemented as an `/exec` of the orchestrator instead of a host sub-agent per issue. The GitHub-issues queue and the Claude-on-host `/exec` contract are unchanged; `/exec` remains the single boundary-crossing mechanism (and, in cockpit mode, runs locally — ADR-0018). The host-Claude layer drives the definition phase and launches execution; sandcastle owns execution autonomously once launched.

Launch constraints that shape the command:

1. **cwd must be the path-matched mount (ADR-0011)**, not `/workspaces/<folder>`: the launch first `cd "$LOCAL_WORKSPACE_FOLDER"`, because `process.cwd()` is what sandcastle anchors worktrees and `.env` to.
2. **Deps live in `.sandcastle/`.** A one-time `npm install` provisions the already-declared devDependencies (`@ai-hero/sandcastle`, `tsx`); this is provisioning, not "adding a dependency".

Today both constraints are encapsulated in `.sandcastle/run.sh` and the baked `afk` / `hitl` launchers (ADR-0018); `/afk` execs those rather than a hand-assembled `tsx` command line. The orchestrator is a long-lived listener, not a one-shot script (ADR-0008).

*(This section absorbs the former ADR-0005, which is removed.)*
