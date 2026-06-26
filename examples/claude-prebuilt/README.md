# Standard: Claude + prebuilt image

The default setup — implement issues with Claude, using the prebuilt GHCR inner
image so there's no local docker build. Best for most adopters.

## Setup

1. Copy the config and add your tokens:

   ```bash
   cp examples/claude-prebuilt/orchestrator.env .sandcastle/orchestrator.env
   # then edit .sandcastle/orchestrator.env → set GH_TOKEN

   # Claude tier also needs the agent's subscription token:
   printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(claude setup-token)" > .sandcastle/.env
   ```

2. Make sure the GHCR package is pullable — it must be public, or run
   `docker login ghcr.io` on the host.

## Run

```bash
afk      # autonomous — one sub-agent per ready-for-agent issue, no interruptions
hitl     # reviewed — approve between issues
```

Each ready issue is implemented in a disposable sandbox from
`ghcr.io/lsfera/agentic-dev/sandbox:latest`; the orchestrator opens a PR per issue.
