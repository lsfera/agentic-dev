# Reproducible: pin every image to a release

Lock both the **inner** sandbox images and the **outer** devcontainer image to a
specific release tag, so a run is byte-for-byte the same image set every time —
no `:latest` drift. Useful for CI, audits, or reproducing a past result.

## Pick a release

```bash
curl -s https://api.github.com/repos/lsfera/agentic-dev/releases | jq -r '.[0].tag_name'
# → e.g. v0.1.3
```

Use that tag everywhere below (the example files use `v0.1.3`).

## Inner images

```bash
cp examples/pinned-reproducible/orchestrator.env .sandcastle/orchestrator.env
# then edit .sandcastle/orchestrator.env → set GH_TOKEN (and the pinned tag)

printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(claude setup-token)" > .sandcastle/.env
```

## Outer image (the devcontainer)

Pin the prebuilt outer image in `.devcontainer/docker-compose.yml` — comment out
the `build:` block and use the pinned `image:` instead:

```yaml
services:
  devcontainer:
    container_name: ${DEVCONTAINER_NAME:-devcontainer}
    image: ghcr.io/lsfera/agentic-dev/devcontainer:v0.1.3   # instead of build:
    # build:
    #   context: .
    #   dockerfile: Dockerfile
```

Then `./up.sh .` pulls the pinned outer image rather than building it.

## Run

```bash
afk      # autonomous
hitl     # reviewed
```
