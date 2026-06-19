# agentic.dev

A reusable devcontainer that runs an agentic development workflow inside a Docker sandbox. Claude drives the feature lifecycle from requirements to implementation; all shell execution is isolated in the container. **One shared `.devcontainer` serves every project** — each project is a subfolder you spin up on demand.

## TL;DR

```bash
bash .devcontainer/init.sh     # one-time: generate .devcontainer/.env on the host
./up.sh cv                     # spin up the sandbox, mounting ./cv at /workspaces/cv
                               # …drive the workflow with Claude (see "The workflow")…
./down.sh cv                   # tear the sandbox down when done
```

You do **not** need VS Code — the workflow is headless (see [Do I need VS Code?](#do-i-need-vs-code)).

## How it fits together

```
        host (you + Claude Code)                     Docker
   ┌──────────────────────────────┐         ┌──────────────────────┐
   │  /grill /to-prd /to-issues   │         │  service: devcontainer│
   │  /afk /hitl  ───────────────┐│         │  /workspaces/<folder> │
   │                  /exec      ││ docker  │  (your ./folder bound)│
   │   mcp__docker__run_command ─┼┼─────────►  vscode user          │
   │      (service=devcontainer) ││ compose │  docker CLI (DooD)    │
   └──────────────────────────────┘  exec   └──────────────────────┘
                  │                                     │
                  └── GitHub issues = durable state ────┘
```

- **Claude runs on the host** and shells into the container with `/exec` → `mcp__docker__run_command(service="devcontainer")`, a thin `docker compose exec` wrapper. Nothing AI runs inside the container.
- **GitHub issues are the durable state.** The container is disposable; progress lives in issues, not in local files.

## Run commands

| Command | What it does |
|---------|--------------|
| `bash .devcontainer/init.sh` | One-time on the host: writes `.devcontainer/.env` (paths, persist dir). Idempotent; also re-run automatically by `up.sh`. |
| `./up.sh <folder>` | Spin up the sandbox for `<folder>`, bound at `/workspaces/<folder>`. Rebuilds the container (image layers stay cached). |
| `./down.sh <folder>` | Tear down the sandbox for `<folder>`. |
| `./down.sh` | Tear down **all** sandboxes started from this repo (safe — scoped by label, never touches other projects). |
| `./code.sh <folder>` | *Optional.* Open VS Code attached to the running sandbox, at `/workspaces/<folder>`. |
| `docker exec -it $(docker ps -q --filter label=devcontainer.local_folder=$PWD/<folder>) bash` | *Optional.* Drop into a shell in the running sandbox without VS Code. |

`up.sh` is a wrapper; the raw equivalent is:

```bash
devcontainer up \
  --workspace-folder "$(pwd)/cv" \
  --config .devcontainer/devcontainer.json \
  --remove-existing-container
```

`--config` is required because the devcontainer CLI only auto-discovers a `.devcontainer/` *inside* the workspace folder, while here it's shared one level up. The workspace path can be **relative or absolute and live anywhere** — `up.sh` exports `AGENTIC_DC_INIT` so the `initializeCommand` runs this repo's `init.sh`. (The under-repo walk-up only matters for VS Code *Reopen in Container*, which doesn't set that variable.)

## Do I need VS Code?

**No.** The agentic workflow is headless: Claude reaches the container from the host via the docker MCP sandbox (`/exec`), so the loop runs with nothing but the container up. There are two ways to *be inside* the container, both optional and only for when **you** want to look or edit interactively:

| You want to… | Do this |
|--------------|---------|
| Run the agentic workflow | Just `./up.sh <folder>` — no editor needed |
| Edit/inspect in VS Code | `./code.sh <folder>` (attaches at the right workspace folder), **or** in VS Code: *Dev Containers: Attach to Running Container* → pick the container → *File ▸ Open Folder ▸ `/workspaces/<folder>`* |
| Just a shell | `docker exec -it <container> bash` (see table above) |

Attaching VS Code to an already-running container is fine and does not disturb the workflow — it's the same container, just with an editor pointed at it.

## The workflow

End to end, from a clean checkout to merged work:

1. **One-time setup**
   - `bash .devcontainer/init.sh` — generates `.devcontainer/.env`.
   - Add `mcp__docker__run_command` to the `allow` list in `.claude/settings.local.json` (see [Permissions](#permissions)).
   - Make sure the docker MCP server targets this repo's compose project (see [Sandbox wiring](#sandbox-wiring)).
2. **Create a project folder** under this repo, e.g. `mkdir cv`.
3. **Spin up the sandbox:** `./up.sh cv`.
4. **`/grill-me-with-docs`** — Claude interviews you and reads any docs you point at, producing `docs/grill-output.md`.
5. **`/to-prd`** — turns the interview into a structured `docs/prd.md`.
6. **`/to-issues`** — breaks the PRD into **vertical slices** as GitHub issues. Unblocked issues get the `ready-for-agent` label.
7. **Implement** — pick one:
   - **`/afk`** — autonomous: spawns one sub-agent per `ready-for-agent` issue, implements with `/tdd`, commits, closes, and re-labels newly-unblocked dependents. No interruptions.
   - **`/hitl`** — same, but pauses for your approval between issues.
8. **Review & merge** the resulting commits/PRs as usual.
9. **`./down.sh cv`** when finished.

Each implementation sub-agent is constrained to: the issue body verbatim, `/exec` for all shell (never host Bash), scope limited to that issue's files, no pushing to main, no extra dependencies, and `/tdd` discipline.

## Slash commands

| Command | Phase | Output |
|---------|-------|--------|
| `/grill-me-with-docs` | Interview — ask questions, read provided docs | `docs/grill-output.md` |
| `/to-prd` | Structure the requirements | `docs/prd.md` |
| `/to-issues` | Break PRD into vertical slices | GitHub issues (label: `ready-for-agent`) |
| `/afk` | Autonomous implementation — sub-agent per issue, no interruptions | commits + closed issues |
| `/hitl` | Reviewed implementation — approve between each issue | commits + closed issues |

Supporting commands:

| Command | Purpose |
|---------|---------|
| `/exec <cmd>` | Run a shell command in the Docker sandbox (`mcp__docker__run_command(service="devcontainer")`). The **only** place that MCP tool is named — every other command routes through it. |
| `/tdd` | Red → green → refactor loop for each acceptance criterion. Used by the implementation agents. |

### Issue lifecycle

- `/to-issues` creates issues as **vertical slices** (end-to-end value, not layers) and applies `ready-for-agent` only to issues with no blockers.
- `/afk` and `/hitl` pick up **only** `ready-for-agent` issues.
- After an issue closes, its dependents are re-checked; if all their blockers are now closed, they get `ready-for-agent`.
- **GitHub is the durable state** — nothing is stored in `/tmp` or local files that would be lost on container restart.

## Devcontainer internals

| File | Role |
|------|------|
| `up.sh` | Spin up the shared devcontainer for a subfolder (`./up.sh cv`). |
| `down.sh` | Tear down sandboxes from this repo, scoped by label (`./down.sh [folder]`). |
| `code.sh` | Optional: attach VS Code to a running sandbox at its workspace folder. |
| `.devcontainer/Dockerfile` | Ubuntu 24.04 devcontainer base; bakes in `claude-persist-setup`. |
| `.devcontainer/docker-compose.yml` | Service `devcontainer` — the sandbox target. Mounts workspace (`consistency: cached`), SSH (ro), Claude persist dir, Docker socket. |
| `.devcontainer/devcontainer.json` | `claude-code` + `docker-outside-of-docker` features; walk-up `initializeCommand`; `postCreateCommand` → `claude-persist-setup`. |
| `.devcontainer/init.sh` | Host-side: generates `.env`, pre-creates the persist dir. |
| `.devcontainer/claude-persist-setup` | Symlinks `~/.claude.json` + `~/.claude/` into the persist mount. |

### Sandbox

`mcp__docker__run_command(service="devcontainer")` is a plain `docker compose exec` wrapper — no AI model, it just runs a command in the running `devcontainer` service. Claude reaches it through `/exec`. This works from the **host**, so the sandbox itself does not require Docker installed inside the container.

Docker *inside* the container (for `docker build`, testcontainers, etc. invoked by the workflow) is provided separately by the `docker-outside-of-docker` feature, which installs the CLI and shares the host socket. Socket permissions for the non-root `vscode` user are fixed by the feature at startup — no `group_add`/`DOCKER_GID` needed.

### Sandbox wiring

For `/exec` to land in *this* repo's container, the docker MCP server must run `docker compose exec` against this project (service `devcontainer`). After `./up.sh <folder>`, sanity-check with `/exec whoami` → expect `vscode`. If it can't find the service, point the MCP server's compose context at `.devcontainer/docker-compose.yml`.

### Claude persistence

Config, MCP registrations, and memory persist on the host at `~/.devcontainer-claude/`, surviving container rebuilds. `.env` reflects the **last** folder spun up (`init.sh` upserts the workspace paths on each `up.sh`).

## Permissions

Add `mcp__docker__run_command` to the `allow` list in `.claude/settings.local.json` so `/exec` never prompts:

```json
{
  "permissions": {
    "allow": ["mcp__docker__run_command"]
  }
}
```

## Notes

- **`consistency: cached`** on the workspace mount is a no-op on modern Docker Desktop (VirtioFS) — kept for correct intent / older osxfs. The real macOS perf levers are VirtioFS (default) and **not** bind-mounting heavy dirs (`node_modules`, `.venv`) — use named volumes for those.
- **Workspace folder can live anywhere** when launched via `up.sh` (it exports `AGENTIC_DC_INIT`). Only VS Code *Reopen in Container* needs the folder under this repo, since it relies on the walk-up fallback to find `.devcontainer/init.sh`.
