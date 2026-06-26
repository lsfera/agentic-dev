# agentic-dev

A reusable devcontainer + agentic workflow. Claude runs on the **host** and drives a
disposable Docker sandbox; GitHub issues hold the durable state. See `README.md` for the
full picture — this file is the operating contract.

## Execution environment

- When a sandbox is running, **use `/exec` for all shell commands**, never the Bash tool.
  `/exec` routes to `mcp__docker__run_command(service="devcontainer")` (a `docker compose exec` wrapper).
- The workflow is **headless** — VS Code is never required. (`code.sh` exists only for the human.)
- Each project is **self-contained**: it holds its own `.devcontainer/`, gets a per-project
  container name (`DEVCONTAINER_NAME`), and is discovered natively by `devcontainer up` /
  VS Code *Reopen in Container* (ADR-0012). `/exec` targets `devcontainer:<DEVCONTAINER_NAME>`
  (this repo: `agentic-dev`).

## Run commands (host)

```
./up.sh .                    # spin up THIS project's sandbox (init.sh runs automatically)
./up.sh <folder>             # any folder holding its own .devcontainer/
./down.sh <folder>           # tear down that sandbox   (./down.sh = all from this repo)
./code.sh <folder>           # optional: attach VS Code to a running sandbox
```

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
fallback). Both are groundwork for running the workflow from *inside* the container; this
repo still drives it from the host via `/exec`, using the workspace `.claude/commands`.

### Issue lifecycle

- `to-issues` creates issues as vertical slices and applies `ready-for-agent` to unblocked ones.
- `afk`/`hitl` pick up only `ready-for-agent` issues.
- After each close, dependents are checked and labelled if now unblocked.
- GitHub issues are the durable state — nothing is stored locally.

### Implementation approach

Each implementation sub-agent uses `/tdd` (red → green → refactor) per acceptance criterion,
runs all shell via `/exec`, stays scoped to its issue's files, and never pushes to main or
adds dependencies on its own.

## Permissions

Add `mcp__docker__run_command` to the `allow` list in `.claude/settings.local.json` so `/exec`
never prompts:

```json
{
  "permissions": {
    "allow": ["mcp__docker__run_command"]
  }
}
```
