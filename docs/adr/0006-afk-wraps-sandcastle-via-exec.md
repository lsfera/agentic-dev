# /afk becomes a thin wrapper that /execs the sandcastle orchestrator

The sandcastle orchestrator runs inside the outer devcontainer, so something must launch it. We keep agentic.dev's user-facing verb: `/afk` still means "run the ready-for-agent queue", but its implementation changes from "host sub-agent per issue" to `/exec npx tsx .sandcastle/main.ts`. The command, the GitHub-issues queue, and the Claude-on-host `/exec` contract are all unchanged — only the execution engine swaps.

## Consequences

- No new vocabulary or workflow step for the user; the engine swap is invisible at the command surface.
- The host-Claude layer stays the top driver for the definition phase (`/grill` → `/to-prd` → `/to-issues`) and for launching execution; sandcastle owns execution autonomously once launched.
- `/exec` remains the single boundary-crossing mechanism, consistent with agentic.dev's existing contract.

## Implementation note — validated launch form (slice 1)

`/exec npx tsx .sandcastle/main.ts` above is the shorthand; the validated form
(issue #1) is more specific because of two constraints discovered later:

1. **cwd must be the path-matched mount (ADR-0011), not `/workspaces/<folder>`.**
   So the launch first `cd "$LOCAL_WORKSPACE_FOLDER"`; `process.cwd()` there is
   what sandcastle anchors worktrees/`.env` to.
2. **Deps live in `.sandcastle/`.** A one-time `npm install` provisions the
   *already-declared* devDependencies (`@ai-hero/sandcastle`, `tsx`) from
   `.sandcastle/package.json` — this is provisioning, not "adding a dependency",
   so it does not conflict with the scope guardrail. The run then invokes
   `.sandcastle`'s own `tsx` so module resolution finds sandcastle:

   ```
   cd "$LOCAL_WORKSPACE_FOLDER" \
     && (cd .sandcastle && npm install) \
     && ./.sandcastle/node_modules/.bin/tsx .sandcastle/main.ts
   ```

   Still launched through `/exec` per this ADR; only the command body is pinned
   to the validated, path-matched shape.
