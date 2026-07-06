# dotnet: non-TypeScript target project

Run `/afk`/`/hitl` against a dotnet (C#) target project instead of the
default JS/TS assumption — the first validated non-TypeScript recipe. See
[ADR-0024](../../docs/adr/0024-sandcastle-is-not-a-language-constraint.md)
and [ADR-0002's addendum](../../docs/adr/0002-lean-inner-image-per-project-extension.md)
for why this is purely a Dockerfile + config recipe, with no changes needed
to the orchestrator's language handling.

This recipe is validated against a small, purpose-built fixture repo
([`lsfera/dotnet-afk-proof`](https://github.com/lsfera/dotnet-afk-proof),
private) rather than a real production dotnet codebase — copy the pattern
and point at your own project instead.

**Important — `AGENTIC_REPO` does not redirect git pushes.** It only tells
`gh` which repo's issues/PRs to manage; every actual `git push` runs with
the orchestrator process's own working directory as the git checkout
(`main.ts`'s `repoRoot = process.cwd()`). The two must be the **same
repo** — set `AGENTIC_REPO` explicitly only when it matches the checkout
you're running from (e.g. `gh` can't auto-detect origin). Practically, this
means the orchestrator must be launched **with its cwd inside the target
dotnet project's own checkout**, not from `agentic-dev`'s.

## Setup

1. Build the dotnet inner image from `agentic-dev`'s `.sandcastle` context
   (this step doesn't need to run from the target project — it just
   produces a local Docker image):

   ```bash
   docker build -f .sandcastle/Dockerfile.dotnet -t sandcastle-dotnet:local .sandcastle
   ```

   To make the image **owned** (so the #40 orphan sweep won't let another
   project reap its sandboxes), add `--build-arg AGENTIC_PROJECT=<name>`.

2. In the **target dotnet project's own checkout**, add `.sandcastle/.env`
   and `.sandcastle/orchestrator.env` (gitignore both — see
   `agentic-dev/.gitignore`'s `.sandcastle/.env` /
   `.sandcastle/orchestrator.env` entries for the pattern):

   ```bash
   cd /path/to/your-dotnet-project
   mkdir -p .sandcastle
   printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(claude setup-token)" > .sandcastle/.env
   cp /path/to/agentic-dev/examples/dotnet-project/orchestrator.env .sandcastle/orchestrator.env
   # edit .sandcastle/orchestrator.env: GH_TOKEN, and AGENTIC_REPO to match
   # *this* checkout's own origin (owner/name) — see the note above
   ```

## Run

Launched directly from the target project's checkout, referencing
`agentic-dev`'s orchestrator engine (adjust the path to your `agentic-dev`
clone):

```bash
cd /path/to/your-dotnet-project
export GH_TOKEN=$(gh auth token)
export SANDCASTLE_IMAGE=sandcastle-dotnet:local
export AGENTIC_REPO=owner/your-dotnet-project
export SANDCASTLE_CONTAINER_UID=1654   # matches Dockerfile.dotnet's AGENT_UID
export SANDCASTLE_CONTAINER_GID=1654
/path/to/agentic-dev/.sandcastle/node_modules/.bin/tsx /path/to/agentic-dev/.sandcastle/main.ts
```

(If your target project instead has its own `.devcontainer/` built from
`agentic-dev`'s published image, the baked-in `afk`/`hitl` shell launchers
work the same way — they resolve `.sandcastle/main.ts` relative to that
project's own workspace, so cwd is already correct.)

## Adapting this to another language

The pattern generalizes: swap `Dockerfile.dotnet`'s base image
(`mcr.microsoft.com/dotnet/sdk:8.0`) for the lean official upstream image of
your language (e.g. `rust:1-slim`, `python:3.12-slim`), keep the same
git+curl install, non-root user rename, and native Claude Code CLI installer
(`curl -fsSL https://claude.ai/install.sh | bash` — no Node dependency), and
point `SANDCASTLE_IMAGE` at the result. No orchestrator code changes are
needed for any language — see ADR-0024.
