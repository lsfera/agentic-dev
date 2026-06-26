# Build from source

Build the inner images locally and run against them (`sandcastle:local` /
`sandcastle-opencode:local`, the orchestrator's defaults). Use this when hacking
on agentic-dev itself, on an air-gapped host, or when you need to customize the
inner image — no GHCR pull involved.

## Setup

1. Build the inner image(s) from the `.sandcastle` context:

   ```bash
   # Claude tier:
   docker build -f .sandcastle/Dockerfile          -t sandcastle:local          .sandcastle
   # Local/Ollama tier (optional):
   docker build -f .sandcastle/Dockerfile.opencode -t sandcastle-opencode:local .sandcastle
   ```

   To make the image **owned** (so the #40 orphan sweep won't let another project
   reap its sandboxes), add `--build-arg AGENTIC_PROJECT=<name>`.

2. Copy the config and add your tokens:

   ```bash
   cp examples/build-from-source/orchestrator.env .sandcastle/orchestrator.env
   # then edit .sandcastle/orchestrator.env → set GH_TOKEN

   printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(claude setup-token)" > .sandcastle/.env
   ```

## Run

```bash
afk      # autonomous
hitl     # reviewed
```
