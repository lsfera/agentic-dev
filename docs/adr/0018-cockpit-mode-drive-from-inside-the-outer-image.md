# Cockpit mode — drive the workflow from inside the outer image

ADR-0017 baked the workflow slash commands and upstream skills into the published
image so an adopter doesn't need to vendor `.claude/commands/`. The next step is
letting **Claude itself run inside the container** — no host Claude, no docker MCP
wiring, no host slash commands. This is "cockpit mode."

## Decision

Make the published outer image the **single deployable unit**: with only the compose
file and exported host credentials, a human can run

```
docker compose exec -it devcontainer cockpit
```

and drive `/grill-me-with-docs → /to-prd → /to-issues` entirely from inside, using
the baked commands and the in-container `claude` CLI.

**What changes:**

### `AGENTIC_IN_CONTAINER` marker (Dockerfile `ENV`)

Set `AGENTIC_IN_CONTAINER=1` unconditionally in the image. Any in-container process —
Claude Code, bash scripts, the orchestrator — can detect cockpit context by reading this
variable. The marker makes the switch point explicit and avoids inspecting container
names, hostnames, or socket paths.

### Context-aware `/exec` (one corpus, no forks)

`/exec` is the single shell-dispatch boundary used by all slash commands (ADR-0006).
In cockpit mode it checks `AGENTIC_IN_CONTAINER`:
- **Set:** run the command in the local Bash shell.
- **Absent:** route to `mcp__docker__run_command` (host mode, unchanged).

The `.md` command file stays logic-free; it just states the rule. No slash command is
forked — `/tdd` and the rest work unchanged in both modes.

### Credential passthrough (compose `environment:`)

The compose file forwards `GH_TOKEN`/`GITHUB_TOKEN` and `ANTHROPIC_API_KEY`/
`CLAUDE_CODE_OAUTH_TOKEN` from the **host shell environment** into the container.
No values are committed; each entry is `VAR: ${VAR:-}`. Unset host vars arrive as
empty strings (harmless — the TS resolver and gh/claude CLIs treat empty as absent).

### TypeScript credential resolver (the real logic)

A pure function `resolveCredentials(env, orchEnv)` in the orchestrator resolves
credentials from both sources with **env taking precedence**:

- `env` = `process.env` (includes docker-compose forwarded vars in cockpit mode)
- `orchEnv` = parsed `orchestrator.env` (via `parseOrchEnv`, a second pure function)

A non-empty value in `env` wins over `orchEnv`; missing or empty env values fall
through. The resolved credentials are the single source for the orchestrator's own
gh calls and for what it forwards to sandcastle's inner sandboxes. Cockpit Claude
(the outer driver) and the orchestrator resolve from the same source.

Both functions are unit-tested in the `reduce.test.ts` / `sandbox-runner.test.ts`
style: no Docker, no GitHub, no network. The `cockpit` boolean field of
`ResolvedCredentials` (derived from `AGENTIC_IN_CONTAINER`) is exercised through
this resolver, not a separate bash dry-run.

### Global `~/.claude/settings.json` (baked, installed by `claude-persist-setup`)

A `cockpit-settings.json` is baked to `/opt/agentic-settings/settings.json` and
installed into `~/.claude/settings.json` at container creation by `claude-persist-setup`
(alongside baked commands and skills). It pre-allows `gh`, `git`, `afk`, and `hitl`
so the human isn't interrupted by permission prompts during the cockpit workflow.
A workspace `.claude/settings.local.json` overrides it via Claude Code's normal
settings hierarchy.

### `cockpit` shim (`/usr/local/bin/cockpit`, baked)

A thin shell script that `cd`s to `${WORKSPACE_FOLDER:-/workspace}` and `exec`s
`claude`. This lands `docker compose exec -it devcontainer cockpit` in the right
directory without the human needing to know the workspace path. No new host script.

## Relation to prior ADRs

- **ADR-0006:** `/exec` remains the single shell boundary; cockpit mode adds a
  second code path (local Bash), but the rule ("only use `/exec`") is unchanged.
- **ADR-0011:** the path-matched host mount is still used by the orchestrator so
  sandcastle's worktrees resolve correctly under docker-outside-of-docker. Cockpit
  mode only relocates the *driver* (outer Claude); the orchestrator topology is
  unchanged.
- **ADR-0016/0017:** cockpit mode is the payoff for baking the orchestrator source
  and workflow commands into the image. Those ADRs called this groundwork; this ADR
  activates it.

## Consequences

- A human can run the definition phase (`/grill→/to-prd→/to-issues`) with only
  the compose file and exported credentials — no Claude installation on the host.
- The published image is now the complete deployable unit for the full workflow.
- Host-driven mode is unchanged. The docker MCP path, `orchestrator.env`, inner
  sandboxes, and the `afk`/`hitl` launchers all work as before.
- `AGENTIC_IN_CONTAINER` is unconditionally set in the devcontainer image, so any
  process inside the container sees it. Processes that don't check it are unaffected.
