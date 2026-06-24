# /afk

Autonomous implementation. Thin wrapper around the **sandcastle orchestrator**:
it runs inside the outer devcontainer and works each `ready-for-agent` GitHub
issue in its own disposable, git-isolated sandbox, opening a PR per issue. The
old host-sub-agent loop is gone — the engine now lives in `.sandcastle/`.

## Arguments

Steer the tier and model **without editing env files** — pass `$ARGUMENTS`
straight to `.sandcastle/run.sh`, which resolves them to the env vars below
(arguments override `orchestrator.env`). Anything omitted keeps its default.
Both positional (`/afk local qwen3-coder:30b`) and flag (`/afk --tier local
--model qwen3-coder:30b`) forms work.

| Argument | Sets | Example |
|----------|------|---------|
| `local` | `AGENTIC_TIER=local` (Ollama via opencode) | `/afk local` |
| `claude` | `AGENTIC_TIER=claude` (default) | `/afk claude` |
| a bare model name | the **active tier's** model — `AGENTIC_LOCAL_MODEL=ollama/<m>` for the local tier, else `AGENTIC_MODEL=<m>` | `/afk local qwen2.5-coder:32b` |
| `--tier <t>` / `--model <m>` | explicit tier / model | `/afk --tier local --model qwen2.5-coder:32b` |
| `--base <branch>` | `AGENTIC_BASE_BRANCH` | `/afk --base develop` |
| `--concurrency <n>` | `AGENTIC_CONCURRENCY` | `/afk --concurrency 2` |

For the local tier a model missing the `ollama/` prefix gets it added. No
arguments → default behavior (claude tier, `claude-sonnet-4-6`). The mapping
lives in `.sandcastle/run.sh` and is covered by `run-sh.test.ts`; `run.sh
afk … --dry-run` prints the resolved `AGENTIC_*` env without launching.

## Prereqs (one-time)

- Bring the devcontainer up for this repo root (the dogfood "repo works on
  itself" case): `./up.sh .` on the host. The `github-cli` devcontainer feature
  installs `gh`; the `~/.ssh` mount provides git push auth.
- `.sandcastle/.env` contains `CLAUDE_CODE_OAUTH_TOKEN` (mint on the host with
  `claude setup-token`). See `.sandcastle/.env.example`. This is injected into
  the inner sandboxes.
- `.sandcastle/orchestrator.env` contains `GH_TOKEN` for the orchestrator's own
  `gh` calls (issues/labels/PRs). See `.sandcastle/orchestrator.env.example`.
  Kept separate from `.sandcastle/.env` so the token never reaches the sandboxes.
- The inner image exists. Build it once inside the devcontainer:
  `/exec` → `docker build -t sandcastle:local -f .sandcastle/Dockerfile .sandcastle`
  (or `npx @ai-hero/sandcastle build-image`).

## Run

Drive everything through `/exec` (routes to the devcontainer, service
`devcontainer`). `.sandcastle/run.sh` does the setup — `cd` to the path-matched
mount `${LOCAL_WORKSPACE_FOLDER}` (so sandcastle's worktrees resolve under
docker-outside-of-docker, ADR-0011), `npm install`, source `orchestrator.env`
(`GH_TOKEN` for the orchestrator's own `gh` calls — never forwarded to the
sandboxes), then launch via `.sandcastle`'s own `tsx`. Pass `$ARGUMENTS`
straight through (see [Arguments](#arguments)):

```
bash "${LOCAL_WORKSPACE_FOLDER}/.sandcastle/run.sh" afk $ARGUMENTS
```

Examples: `run.sh afk`, `run.sh afk local`, `run.sh afk local qwen2.5-coder:32b`,
`run.sh afk --base develop --concurrency 2`. Use `--dry-run` to print the
resolved `AGENTIC_*` env without launching.

## Behavior

- Serially claims the lowest-numbered `ready-for-agent` issue (removing the
  label to mark it in-progress), runs one sandbox, pushes `agent/issue-<N>`,
  and opens a PR (`Closes #<N>`).
- Stops cleanly when no issue is ready and nothing is in flight.
- Each run is logged under `.sandcastle/logs/`.

## Optional env

- `AGENTIC_REPO` — `owner/name` (default: the cwd repo's origin)
- `AGENTIC_BASE_BRANCH` — PR base (default: `main`)
- `AGENTIC_MODEL` — claudeCode model (default: `claude-sonnet-4-6`)
- `SANDCASTLE_IMAGE` — inner image for the claude tier (default: `sandcastle:local`)
- `AGENTIC_TIER` — agent tier: `claude` (default) or `local` (Ollama via opencode)
- `AGENTIC_LOCAL_MODEL` — opencode model for the local tier (default: `ollama/qwen3-coder:30b`)
- `SANDCASTLE_OPENCODE_IMAGE` — inner image for the local tier (default: `sandcastle-opencode:local`)

### Local tier prereqs

When `AGENTIC_TIER=local`, the local-tier image must exist and Ollama must be
reachable from the devcontainer at `host.docker.internal:11434`:

```
docker build -t sandcastle-opencode:local -f .sandcastle/Dockerfile.opencode .sandcastle
```

The `opencode.json` at the repo root is copied into each worktree automatically
via `copyToWorktree` and configures the Ollama provider.

## Status

The full roadmap is wired: dependency-ordered unblocking (#2), auto-merge on
green CI (#3), `/hitl` merge gate (#4), event-driven smee loop (#5),
concurrency cap (#6), local Ollama tier (#7), orphan teardown (#8), plus
base-branch refresh (#28) and stale-branch reset (#23) before each run.
