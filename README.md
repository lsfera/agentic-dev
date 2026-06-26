# agentic.dev

A reusable devcontainer that runs an agentic development workflow inside a Docker sandbox. Claude drives the feature lifecycle from requirements to implementation; all shell execution is isolated in the container. **Each project is self-contained** — it carries its own `.devcontainer/`, so `devcontainer up` and VS Code *Reopen in Container* discover it natively, the container is named per project, and two projects can run side by side.

## TL;DR

```bash
./up.sh .                      # spin up THIS project's sandbox (init.sh runs automatically)
                               # …drive the workflow with Claude (see "The workflow")…
./down.sh .                    # tear the sandbox down when done
```

`./up.sh <folder>` works for any folder that holds its own `.devcontainer/`; the dogfood case is this repo itself (`./up.sh .`). VS Code users can skip `up.sh` entirely and use *Reopen in Container*.

You do **not** need VS Code — the workflow is headless (see [Do I need VS Code?](#do-i-need-vs-code)).

## How it fits together

```
        host (you + Claude Code)                     Docker
   ┌──────────────────────────────┐         ┌──────────────────────┐
   │  /grill /to-prd /to-issues   │         │  service: devcontainer│
   │  /afk /hitl  ───────────────┐│         │  /workspaces/<project>│
   │                  /exec      ││ docker  │  (your project bound) │
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
| `./up.sh <folder>` | Spin up `<folder>`'s sandbox (the folder must hold its own `.devcontainer/`), bound at `/workspaces/<folder>` in a per-project container. Re-runs `init.sh` automatically; rebuilds the container (image layers stay cached). `./up.sh .` brings up this repo. |
| `./down.sh <folder>` | Tear down the sandbox for `<folder>`. |
| `./down.sh` | Tear down **all** sandboxes started from this repo (safe — scoped by label, never touches other projects). |
| `./code.sh <folder>` | *Optional.* Open VS Code attached to the running sandbox, at `/workspaces/<folder>`. |
| `docker exec -it $(docker ps -q --filter label=devcontainer.local_folder=$PWD/<folder>) bash` | *Optional.* Drop into a shell in the running sandbox without VS Code. |

`up.sh` is a thin wrapper; the raw equivalent is:

```bash
devcontainer up \
  --workspace-folder "$(pwd)" \
  --remove-existing-container
```

No `--config` is needed: the project root holds its own `.devcontainer/`, so the devcontainer CLI (and VS Code *Reopen in Container*) auto-discovers it. The `initializeCommand` runs the in-project `.devcontainer/init.sh`, which derives a per-project container name (`DEVCONTAINER_NAME`, e.g. `agentic-dev`) and writes `.devcontainer/.env`. This replaces the previous shared-`.devcontainer`/`AGENTIC_DC_INIT` model (see [ADR-0012](docs/adr/0012-self-contained-per-project-devcontainer.md)).

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
| `up.sh` | Thin `devcontainer up` wrapper for a self-contained project (`./up.sh .`). |
| `down.sh` | Tear down sandboxes from this repo, scoped by label (`./down.sh [folder]`). |
| `code.sh` | Optional: attach VS Code to a running sandbox at its workspace folder. |
| `.devcontainer/init.sh` | Host `initializeCommand`: derives the per-project `DEVCONTAINER_NAME` and writes `.devcontainer/.env`. `--dry-run` prints the resolved names without side effects. |
| `.devcontainer/Dockerfile` | Ubuntu 24.04 devcontainer base; bakes in `claude-persist-setup`. |
| `.devcontainer/docker-compose.yml` | Service `devcontainer` — the sandbox target, `container_name: ${DEVCONTAINER_NAME}`. Mounts workspace (`consistency: cached`), SSH (ro), Claude persist dir, Docker socket. |
| `.devcontainer/devcontainer.json` | `claude-code` + `docker-outside-of-docker` features; in-project `initializeCommand` → `init.sh`; `postCreateCommand` → `claude-persist-setup`. |
| `.devcontainer/init.sh` | Host-side: generates `.env`, pre-creates the persist dir. |
| `.devcontainer/claude-persist-setup` | Symlinks `~/.claude.json` + `~/.claude/` into the persist mount. |

### Sandbox

`mcp__docker__run_command(service="devcontainer")` is a plain `docker compose exec` wrapper — no AI model, it just runs a command in the running `devcontainer` service. Claude reaches it through `/exec`. This works from the **host**, so the sandbox itself does not require Docker installed inside the container.

Docker *inside* the container (for `docker build`, testcontainers, etc. invoked by the workflow) is provided separately by the `docker-outside-of-docker` feature, which installs the CLI and shares the host socket. Socket permissions for the non-root `vscode` user are fixed by the feature at startup — no `group_add`/`DOCKER_GID` needed.

### Sandbox wiring

For `/exec` to land in *this* repo's container, the docker MCP server must run `docker compose exec` against this project (service `devcontainer`). After `./up.sh <folder>`, sanity-check with `/exec whoami` → expect `vscode`. If it can't find the service, point the MCP server's compose context at `.devcontainer/docker-compose.yml`.

### Claude persistence

Config, MCP registrations, and memory persist on the host at `~/.devcontainer-claude/`, surviving container rebuilds. `.env` reflects the **last** folder spun up (`init.sh` upserts the workspace paths on each `up.sh`).

## Inner sandbox images

Each implementation runs in a disposable inner container built from one of two
images: the default **claude** image (`SANDCASTLE_IMAGE`, default `sandcastle:local`)
and the **local/Ollama** image (`SANDCASTLE_OPENCODE_IMAGE`, default
`sandcastle-opencode:local`). You can either pull prebuilt images or build them
locally.

**Pull prebuilt (no build step).** CI publishes both images, multi-arch
(amd64 + arm64), to GHCR (ADR-0014). Point a project at them with env vars — the
orchestrator already honours these overrides, so nothing else changes:

```bash
export SANDCASTLE_IMAGE=ghcr.io/lsfera/agentic-dev/sandbox:v0.1.1
export SANDCASTLE_OPENCODE_IMAGE=ghcr.io/lsfera/agentic-dev/sandbox-opencode:v0.1.1
```

Set these in `.sandcastle/orchestrator.env` to make them stick. **Pin a version
tag** (as above) rather than `:latest` for reproducible runs — `:latest` floats
to whatever last published. The images are built by
`.github/workflows/publish-images.yml` on version tags (`v*`), on `main`, and via
manual dispatch; each release publishes a matching `:vX.Y.Z` tag.

**Build locally (the default).** The defaults stay `sandcastle:local` /
`sandcastle-opencode:local` so source-of-truth and offline dev don't depend on a
pull. Build them from the `.sandcastle` context:

```bash
docker build -f .sandcastle/Dockerfile          -t sandcastle:local          .sandcastle
docker build -f .sandcastle/Dockerfile.opencode -t sandcastle-opencode:local .sandcastle
```

A project that needs an **owned** image (so the #40 orphan sweep won't let another
project reap its sandboxes) builds with `--build-arg AGENTIC_PROJECT=<name>`; the
published GHCR images are unowned/legacy.

## Outer orchestrator image

The **outer** image — the devcontainer the orchestrator runs in — is also
published to GHCR, multi-arch, as `ghcr.io/lsfera/agentic-dev/devcontainer`
(ADR-0015), so adopters can skip the local devcontainer build (~2.3 GB, four
features). It is a *devcontainer* (base + features + Dockerfile), so it is built
with the devcontainer CLI, not a plain `docker build`; the workflow is
`.github/workflows/publish-devcontainer.yml`.

To consume it instead of building locally, either point the compose service at it

```yaml
# .devcontainer/docker-compose.yml
services:
  devcontainer:
    image: ghcr.io/lsfera/agentic-dev/devcontainer:v0.1.1   # instead of build:
```

or keep `build:` and add the published image as a cache source so `devcontainer up`
is a registry cache hit rather than a full rebuild. The dogfood repo keeps `build:`
as the source of truth, so local development still builds from the Dockerfile.

## Local model tier (Ollama)

By default each implementation sandbox runs Claude (`claudeCode`). You can instead point the implementer at a **local Ollama model** via [opencode](https://opencode.ai) — no API cost, fully offline. Useful for cheap parallel work; quality depends on the local model, so it is not yet a drop-in for Claude on hard slices.

**Prerequisites**

- Ollama running on the host, bound to `0.0.0.0:11434` so containers can reach it at `http://host.docker.internal:11434`.
- A coding model pulled, e.g. `ollama pull qwen3-coder:30b`. Keep weights ~15–22 GB so RAM stays free for Docker + the sandbox stack.

**One-time: get the opencode inner image**

Pull the prebuilt `sandbox-opencode` image or build it locally — see
[Inner sandbox images](#inner-sandbox-images). The local build is:

```bash
docker build -f .sandcastle/Dockerfile.opencode -t sandcastle-opencode:local .sandcastle
```

This image ships the `opencode` CLI (pinned `opencode-ai@1.17.9`) instead of Claude Code. The provider config in `.sandcastle/opencode.json` points opencode at the host Ollama; on sandbox start an `onSandboxReady` hook copies it into opencode's **global** config dir (`~/.config/opencode/`) — opencode resolves its provider from there, not the worktree cwd, so this step is what makes the model actually load.

**Run the orchestrator on the local tier**

The devcontainer image bakes in `afk` and `hitl` commands, so from anywhere inside a project you can just:

```bash
afk                          # autonomous, claude tier
afk local                    # default local model
afk local qwen2.5-coder:32b  # pick a model
hitl local                   # review before merge
```

`afk`/`hitl` are thin launchers over `.sandcastle/run.sh` (which steers tier/model from arguments and handles the `cd` to the path-matched mount, `npm install`, and `orchestrator.env` sourcing). They resolve the project root and set `LOCAL_WORKSPACE_FOLDER` from `.devcontainer/.env` so the run launches from the host-path mount (ADR-0011) regardless of your working directory. The underlying script is equivalent:

```bash
.sandcastle/run.sh afk local qwen2.5-coder:32b
```

The same arguments work from the `/afk` and `/hitl` slash commands (e.g. `/afk local qwen2.5-coder:32b`). A bare model name is routed to the active tier and gets the `ollama/` prefix added if missing. Under the hood the arguments resolve to these env vars (arguments override `orchestrator.env`); `afk … --dry-run` prints the resolved values without launching:

| Env var | Default | Purpose |
|---------|---------|---------|
| `AGENTIC_TIER` | `claude` | Set to `local` (arg: `local`) to use opencode + host Ollama instead of Claude Code. |
| `AGENTIC_LOCAL_MODEL` | `ollama/qwen3-coder:30b` | opencode model ref (`ollama/<model>`); the model must exist in `ollama list`. |
| `SANDCASTLE_OPENCODE_IMAGE` | `sandcastle-opencode:local` | Inner image for the local tier. |

To add a model, pull it in Ollama and add it to the `models` map in `.sandcastle/opencode.json`, then pass it as the model argument (or via `AGENTIC_LOCAL_MODEL`). Verify reachability from a container with `docker run --rm --add-host=host.docker.internal:host-gateway curlimages/curl -s http://host.docker.internal:11434/api/tags`.

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
- **Per-project, self-contained.** Each project carries its own `.devcontainer/`, so `up.sh`, `devcontainer up`, and VS Code *Reopen in Container* all discover the config natively (no `--config` split, no `AGENTIC_DC_INIT`). The container is named per project (`DEVCONTAINER_NAME`, derived from the workspace folder), so two projects don't collide. **Tradeoff:** each project keeps its own copy of `.devcontainer/`, so improvements to the shared config must be propagated to each project (e.g. by re-copying or templating) rather than landing everywhere at once. See [ADR-0012](docs/adr/0012-self-contained-per-project-devcontainer.md).
- **The docker MCP map is per-project.** `/exec` targets the sandbox via `ALLOWED_CONTAINERS=devcontainer:<DEVCONTAINER_NAME>`; for this repo that's `agentic-dev`. Point it at the project's container name (no longer the old fixed `agentic-sandbox`).

## Credits

The orchestrator under `.sandcastle/` is built on **[sandcastle](https://github.com/mattpocock/sandcastle)** by [Matt Pocock](https://github.com/mattpocock) — a TypeScript library for orchestrating sandboxed coding agents (`sandcastle.run()`, published as [`@ai-hero/sandcastle`](https://www.npmjs.com/package/@ai-hero/sandcastle)). It handles the disposable, git-isolated Docker sandbox each agent runs in; this project wraps it into the issue-driven `/afk` and `/hitl` workflow. Thanks to Matt and the sandcastle contributors.
