# Publish prebuilt inner sandbox images to GHCR

Adopting the orchestrator on a new project required building the inner sandbox
images by hand — `docker build -f .sandcastle/Dockerfile -t sandcastle:local …`
and the same for `Dockerfile.opencode`. That is per-machine friction (every host
rebuilds the same image), it pulls the Claude CLI / `opencode-ai` at build time so
results drift with upstream, and it is one more step before a first run.

## Decision

Build both inner images in CI and publish them to GHCR, so adoption is a
`docker pull` + env override instead of a local build.

- A `publish-images.yml` workflow builds `.sandcastle/Dockerfile` and
  `.sandcastle/Dockerfile.opencode` and pushes them to
  `ghcr.io/<owner>/agentic-dev/sandbox` and `…/sandbox-opencode`.
- **Multi-arch** (`linux/amd64,linux/arm64`) from a single manifest: adopters run
  these on Apple-Silicon Docker Desktop as well as amd64 CI/hosts.
- Triggers: version tags (`v*`), pushes to `main` that touch an inner Dockerfile
  (refresh the `main` + `latest` tags), and manual `workflow_dispatch`.
- Tags via `docker/metadata-action`: semver (`{{version}}`, `{{major}}.{{minor}}`)
  on tags, the branch name, the commit `sha`, and `latest` on the default branch.

No orchestrator change is needed: `SandboxRunner` already resolves its image from
`SANDCASTLE_IMAGE` (claude tier) and `SANDCASTLE_OPENCODE_IMAGE` (local tier), so a
project opts in by setting those to a GHCR ref.

## Consequences

- A new project runs without a local image build: set the two env vars to the
  published refs and go.
- The local-build path is unchanged and stays the default (`sandcastle:local` /
  `sandcastle-opencode:local`), so offline/source-of-truth dev and CI do not
  depend on a network pull. The prebuilt image is an **opt-in**, not the default —
  keeping it default would make every run depend on GHCR availability.
- `AGENTIC_PROJECT` is left empty in the published image, so the #40 project-scoped
  sweep treats it as unowned/legacy (any project may reap a crashed sandbox from
  it). A project that needs an owned image still builds locally with the build-arg.
- GHCR packages are private by default; publishing for public consumption is a
  one-time per-package visibility change in the repo's package settings.
- Pinning still matters: `Dockerfile.opencode` pins `opencode-ai@1.17.9` for the
  CLI shape sandcastle 0.10.0 emits; bumping it is a deliberate, re-verified change
  (see that file's comment), and a published tag freezes whatever was pinned.
