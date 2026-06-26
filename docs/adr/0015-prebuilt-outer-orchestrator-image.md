# Publish the prebuilt outer orchestrator image to GHCR

ADR-0014 published the *inner* sandbox images so adopters skip building those.
The *outer* image — the devcontainer the orchestrator itself runs in — was still
built locally on every adopter's machine by `devcontainer up` (base image + the
claude-code / docker-outside-of-docker / node / github-cli features + the
Dockerfile). That is a slow first-run (~2.3 GB, four features) repeated per host.

## Decision

Build the outer image in CI and publish it to GHCR
(`ghcr.io/<owner>/agentic-dev/devcontainer`), multi-arch (`linux/amd64,linux/arm64`).

Because the outer image is a **devcontainer** — its features are applied by the
devcontainer CLI, not by the Dockerfile — a plain `docker build` of
`.devcontainer/Dockerfile` produces a broken image (no node/docker/gh/claude). So
the workflow builds with the **devcontainer CLI** (`devcontainer build --push`),
which layers the features and pushes. Tags mirror the inner-image workflow (semver
/ branch / sha / `latest` on the default branch), via `docker/metadata-action`.

The build uses a dedicated **dockerfile-based** config, `devcontainer.build.json`,
not the runtime `devcontainer.json` (which is docker-compose, for the workspace /
SSH / persist / socket mounts and the path-match). The CLI **rejects
`--platform`/`--push` for compose-based configs** (`--platform or --push not
supported`) — this was caught by the first CI run, which had pointed at the compose
config. The runtime mounts are irrelevant to image content, so `devcontainer.build.json`
mirrors only the `build.dockerfile` + `features`; it must be kept in sync with
`devcontainer.json`'s feature list.

Validated locally: `devcontainer build --config devcontainer.build.json --platform
linux/arm64` succeeds (and on the compose config yields an image with `node`,
`docker`, `gh`, `claude`, and the baked-in `afk`/`hitl` all present).

## Consequences

- Adopters can consume the prebuilt image instead of building locally — either by
  pointing the compose service at it (`image:`) or adding it as a build
  `cacheFrom` source so `devcontainer up` is a cache hit. The dogfood compose file
  keeps its `build:` block (source of truth); consumption is documented, not
  forced, so local development still builds from the Dockerfile.
- A correctness prerequisite surfaced while validating this: `.devcontainer/`
  uses an allowlist `.dockerignore` (`*` then `!Dockerfile` …), so every file the
  Dockerfile `COPY`s must be allowlisted. The `afk` launcher (ADR — baked-in
  command) was missing its `!afk` entry, which broke the devcontainer build; this
  workflow's validation caught and fixed it.
- The arm64 leg builds under QEMU emulation, so the job is slow (generous
  `timeout-minutes`). If it becomes a bottleneck, switch to native per-arch
  runners (`ubuntu-24.04-arm`) with a manifest-merge step.
- Path-scoped to `.devcontainer/**` on `main`, plus every `v*` tag and manual
  dispatch — kept in a separate workflow from the inner images so a change to one
  image type does not rebuild the other.
