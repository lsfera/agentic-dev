# agentic.dev

A reusable devcontainer + agentic workflow. Claude runs on the **host** and drives a
disposable Docker sandbox; GitHub issues hold the durable state. See `README.md` for the
full picture — this file is the operating contract.

## Execution environment

- When a sandbox is running, **use `/exec` for all shell commands**, never the Bash tool.
  `/exec` routes to `mcp__docker__run_command(service="devcontainer")` (a `docker compose exec` wrapper).
- The workflow is **headless** — VS Code is never required. (`code.sh` exists only for the human.)
- One shared `.devcontainer` serves every project; each project is a subfolder.

## Run commands (host)

```
bash .devcontainer/init.sh   # one-time: generate .devcontainer/.env
./up.sh <folder>             # spin up sandbox, mount ./<folder> at /workspaces/<folder>
./down.sh <folder>           # tear down that sandbox   (./down.sh = all from this repo)
./code.sh <folder>           # optional: attach VS Code to a running sandbox
```

## Development workflow

```
./up.sh <folder>      →  sandbox up at /workspaces/<folder>
/grill-me-with-docs   →  interview + docs/grill-output.md
/to-prd               →  docs/prd.md
/to-issues            →  GitHub issues (vertical slices, label: ready-for-agent)
/afk                  →  autonomous: sub-agent per issue, no interruptions
/hitl                 →  reviewed: sub-agent per issue, approve between each
./down.sh <folder>    →  tear down when done
```

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
