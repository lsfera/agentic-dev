# /afk becomes a thin wrapper that /execs the sandcastle orchestrator

The sandcastle orchestrator runs inside the outer devcontainer, so something must launch it. We keep agentic.dev's user-facing verb: `/afk` still means "run the ready-for-agent queue", but its implementation changes from "host sub-agent per issue" to `/exec npx tsx .sandcastle/main.ts`. The command, the GitHub-issues queue, and the Claude-on-host `/exec` contract are all unchanged — only the execution engine swaps.

## Consequences

- No new vocabulary or workflow step for the user; the engine swap is invisible at the command surface.
- The host-Claude layer stays the top driver for the definition phase (`/grill` → `/to-prd` → `/to-issues`) and for launching execution; sandcastle owns execution autonomously once launched.
- `/exec` remains the single boundary-crossing mechanism, consistent with agentic.dev's existing contract.
