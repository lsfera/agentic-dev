# /afk

Autonomous implementation. Thin wrapper around the **sandcastle orchestrator**:
it runs inside the outer devcontainer and works each `ready-for-agent` GitHub
issue in its own disposable, git-isolated sandbox, opening a PR per issue. The
old host-sub-agent loop is gone — the engine now lives in `.sandcastle/`.

## Arguments

`/afk` takes optional arguments so you can steer the tier and model **without
editing env files**. Parse `$ARGUMENTS`, map them to the env vars below, and
prepend those assignments to the launch command; anything omitted keeps its
default. Both positional (`/afk local qwen3-coder:30b`) and flag
(`/afk --tier local --model qwen3-coder:30b`) forms are accepted.

| Argument | Sets | Example |
|----------|------|---------|
| `local` | `AGENTIC_TIER=local` (Ollama via opencode) | `/afk local` |
| `claude` | `AGENTIC_TIER=claude` (default) | `/afk claude` |
| a bare model name | the **active tier's** model — `AGENTIC_LOCAL_MODEL=ollama/<m>` for the local tier, else `AGENTIC_MODEL=<m>` | `/afk local qwen2.5-coder:32b` |
| `--tier <t>` / `--model <m>` | explicit `AGENTIC_TIER` / model | `/afk --tier local --model qwen2.5-coder:32b` |
| `--base <branch>` | `AGENTIC_BASE_BRANCH` | `/afk --base develop` |
| `--concurrency <n>` | `AGENTIC_CONCURRENCY` | `/afk --concurrency 2` |

Resolution rules:
- A bare model name with no tier keyword applies to the selected tier (default
  `claude`). For the local tier, a model missing the `ollama/` prefix gets it
  added (`qwen3-coder:30b` → `ollama/qwen3-coder:30b`).
- No arguments → current default behavior (claude tier, `claude-sonnet-4-6`).
- If an argument is ambiguous, state how you interpreted it before running.

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
`devcontainer`). Run from the **path-matched mount** `${LOCAL_WORKSPACE_FOLDER}`
so the worktrees sandcastle creates resolve under docker-outside-of-docker
(ADR-0011) — not from `/workspaces/<folder>`:

```
cd "$LOCAL_WORKSPACE_FOLDER" \
  && (cd .sandcastle && npm install) \
  && set -a && . .sandcastle/orchestrator.env && set +a \
  && AGENTIC_MODE=afk <RESOLVED_ARGS> ./.sandcastle/node_modules/.bin/tsx .sandcastle/main.ts
```

`<RESOLVED_ARGS>` is the space-separated env assignments you derived from
`$ARGUMENTS` (see [Arguments](#arguments)) — e.g. `/afk local qwen2.5-coder:32b`
becomes `AGENTIC_TIER=local AGENTIC_LOCAL_MODEL=ollama/qwen2.5-coder:32b`. With
no arguments it is empty.

`cd "$LOCAL_WORKSPACE_FOLDER"` keeps the orchestrator's `process.cwd()` (and
thus sandcastle's `cwd`) on the host-resolvable path; invoking `.sandcastle`'s
own `tsx` resolves `@ai-hero/sandcastle` from `.sandcastle/node_modules`.
Sourcing `orchestrator.env` puts `GH_TOKEN` in the orchestrator's environment so
its `gh` calls authenticate; it is not forwarded to the sandboxes.

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
