# dotnet: non-TypeScript target project

Run `/afk`/`/hitl` against a dotnet (C#) target project instead of the
default JS/TS assumption — the first validated non-TypeScript recipe. See
[ADR-0024](../../docs/adr/0024-sandcastle-is-not-a-language-constraint.md)
and [ADR-0002's addendum](../../docs/adr/0002-lean-inner-image-per-project-extension.md)
for why this is purely a Dockerfile + config recipe, with no changes needed
to the orchestrator itself.

This recipe is validated against a small, purpose-built fixture repo
([`lsfera/dotnet-afk-proof`](https://github.com/lsfera/dotnet-afk-proof),
private) rather than a real production dotnet codebase — copy the pattern
and point `AGENTIC_REPO` at your own project instead.

## Setup

1. Build the dotnet inner image from the `.sandcastle` context:

   ```bash
   docker build -f .sandcastle/Dockerfile.dotnet -t sandcastle-dotnet:local .sandcastle
   ```

   To make the image **owned** (so the #40 orphan sweep won't let another
   project reap its sandboxes), add `--build-arg AGENTIC_PROJECT=<name>`.

2. Copy the config and add your tokens:

   ```bash
   cp examples/dotnet-project/orchestrator.env .sandcastle/orchestrator.env
   # then edit .sandcastle/orchestrator.env → set GH_TOKEN, and AGENTIC_REPO
   # if targeting your own dotnet project instead of the validation fixture

   printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(claude setup-token)" > .sandcastle/.env
   ```

## Run

```bash
afk      # autonomous
hitl     # reviewed
```

## Adapting this to another language

The pattern generalizes: swap `Dockerfile.dotnet`'s base image
(`mcr.microsoft.com/dotnet/sdk:8.0`) for the lean official upstream image of
your language (e.g. `rust:1-slim`, `python:3.12-slim`), keep the same
git+curl install, non-root user rename, and native Claude Code CLI installer
(`curl -fsSL https://claude.ai/install.sh | bash` — no Node dependency), and
point `SANDCASTLE_IMAGE` at the result. No orchestrator code changes are
needed for any language — see ADR-0024.
