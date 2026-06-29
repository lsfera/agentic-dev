# agentic-dev

A reusable devcontainer + agentic workflow. GitHub issues hold the durable state.
See `README.md` for the full picture — this file is the operating contract.

There are two ways to drive the workflow:

| Mode | Where Claude runs | How to start |
|------|------------------|--------------|
| **Host-driven** (default) | On the host; reaches the container via docker MCP | `./up.sh .` then open a host Claude session |
| **Cockpit** | Inside the devcontainer | `docker compose exec -it devcontainer cockpit` |

Both modes use the same slash commands. `/exec` detects the context automatically
(`AGENTIC_IN_CONTAINER` env var, baked into the image) and routes correctly.

## Execution environment

- **Use `/exec` for all shell commands**, never the Bash tool directly.
  - **Host mode:** `/exec` routes to `mcp__docker__run_command(service="devcontainer")`.
  - **Cockpit mode:** `/exec` runs the command in the local shell (inside the container).
- The workflow is **headless** — VS Code is never required. (`code.sh` exists only for the human.)
- Each project is **self-contained**: it holds its own `.devcontainer/`, gets a per-project
  container name (`DEVCONTAINER_NAME`), and is discovered natively by `devcontainer up` /
  VS Code *Reopen in Container* (ADR-0012). In host mode, `/exec` targets
  `devcontainer:<DEVCONTAINER_NAME>` (this repo: `agentic-dev`).

## Run commands (host-driven mode)

```
./up.sh .                    # spin up THIS project's sandbox (init.sh runs automatically)
./up.sh <folder>             # any folder holding its own .devcontainer/
./down.sh <folder>           # tear down that sandbox   (./down.sh = all from this repo)
./code.sh <folder>           # optional: attach VS Code to a running sandbox
```

## Cockpit mode (drive from inside the container)

With only the compose file and exported credentials — no host Claude, no docker MCP wiring:

```sh
# Export credentials on the host, then:
docker compose -f .devcontainer/docker-compose.yml exec -it devcontainer cockpit
# → lands in Claude Code inside the container, at the workspace root
```

The workflow slash commands (`/grill-me-with-docs`, `/to-prd`, `/to-issues`, `/afk`, `/hitl`)
are baked into the published image and available immediately (ADR-0017/0018).

### Autonomous cockpit: kick off, monitor, stop

Inside cockpit, `/afk` (and `/hitl`) **detach automatically** — the orchestrator
starts as a background job, freeing the interactive Claude session immediately:

```sh
/afk          # kicks off, prints PID + log path, returns to prompt
```

The orchestrator writes to `.sandcastle/logs/<mode>-<timestamp>.log` and saves
its PID in `.sandcastle/<mode>.pid`. To monitor or stop it:

```sh
# Tail the live log (Ctrl-C to stop tailing; orchestrator keeps running)
tail -f .sandcastle/logs/afk-*.log

# Check the PID
cat .sandcastle/afk.pid

# Stop the orchestrator
kill $(cat .sandcastle/afk.pid) && rm .sandcastle/afk.pid
```

Host-driven `/afk`/`/hitl` (via `/exec`) are unaffected — they run in the
foreground as before.

## Development workflow

```
./up.sh .             →  sandbox up at /workspaces/<project>
/grill-me-with-docs   →  interview + docs/grill-output.md
/to-prd               →  docs/prd.md
/to-issues            →  GitHub issues (vertical slices, label: ready-for-agent)
/afk                  →  autonomous: sub-agent per issue, no interruptions
/hitl                 →  reviewed: sub-agent per issue, approve between each
./down.sh <folder>    →  tear down when done
```

Inside the devcontainer the image bakes in `afk` / `hitl` shell commands (thin
launchers over `.sandcastle/run.sh`) — run `afk [tier] [model] [flags]` or
`hitl …` from anywhere in a project. They resolve the project root and set
`LOCAL_WORKSPACE_FOLDER` from `.devcontainer/.env` so the run honours the
path-matched mount (ADR-0011) regardless of cwd. `afk --dry-run` prints the
resolved env without launching.

The **published** image additionally bakes the workflow slash commands → `~/.claude/commands`
and four upstream engineering disciplines → `~/.claude/skills` (ADR-0017), and
`.devcontainer/docker-compose.yml` boots standalone without `init.sh` (every var has a
fallback). This is what cockpit mode depends on.

### Issue lifecycle

- `to-issues` creates issues as vertical slices and applies `ready-for-agent` to unblocked ones.
- `afk`/`hitl` pick up only `ready-for-agent` issues.
- After each close, dependents are checked and labelled if now unblocked.
- GitHub issues are the durable state — nothing is stored locally.

### Sandbox retry semantics (#76)

When a sandbox fails (throws or produces no commits) the orchestrator automatically
re-labels the issue `ready-for-agent` so the next tick picks it up again, up to
`Policy.maxRetries` times per run (default **2**). After the cap the issue is left
unlabelled and a comment explains the exhaustion — never an infinite retry loop.

**Known limitation:** attempt counts live in the orchestrator's in-run state and
reset when the orchestrator restarts. A persistently-failing issue gets another
`maxRetries` attempts on each fresh orchestrator run. In-run bounding is sufficient
for v1; cross-run persistence is not implemented.

### Implementation approach

Each implementation sub-agent uses `/tdd` (red → green → refactor) per acceptance criterion,
runs all shell via `/exec`, stays scoped to its issue's files, and never pushes to main or
adds dependencies on its own.

## Permissions

**Host-driven mode:** add `mcp__docker__run_command` to the `allow` list in
`.claude/settings.local.json` so `/exec` never prompts:

```json
{
  "permissions": {
    "allow": ["mcp__docker__run_command"]
  }
}
```

**Cockpit mode:** the published image bakes a global `~/.claude/settings.json` that
pre-allows `gh`, `git`, `afk`, and `hitl` (installed by `claude-persist-setup`). A
workspace `.claude/settings.local.json` overrides it as usual.
