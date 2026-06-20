# /afk

Autonomous implementation. Thin wrapper around the **sandcastle orchestrator**:
it runs inside the outer devcontainer and works each `ready-for-agent` GitHub
issue in its own disposable, git-isolated sandbox, opening a PR per issue. The
old host-sub-agent loop is gone — the engine now lives in `.sandcastle/`.

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
  && AGENTIC_MODE=afk ./.sandcastle/node_modules/.bin/tsx .sandcastle/main.ts
```

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
- `SANDCASTLE_IMAGE` — inner image (default: `sandcastle:local`)

## Not yet wired (later issues)

Auto-merge on green CI (#3), `/hitl` merge gate (#4), event-driven smee loop
(#5), dependency-ordered unblocking (#2), concurrency > 1 (#6), local Ollama
tier (#7), and orphan teardown (#8). This wrapper is the slice-1 walking
skeleton: one issue → sandbox → PR, serial, poll-once.
