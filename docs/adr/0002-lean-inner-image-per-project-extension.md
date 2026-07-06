# Inner agentic-sandbox image is sandcastle's lean default, extended per-project

The inner sandbox image is kept separate from the outer devcontainer image. The baseline is sandcastle's default `.sandcastle/Dockerfile` (Node 22 + git + gh + Claude Code CLI as non-root), which covers JS/TS work. Toolchain-heavy projects derive their own `.sandcastle/Dockerfile` `FROM` the matching `devcontainer-*` image in this workspace (rust/python/dotnet/vue) and layer the Claude CLI on top.

We deliberately do **not** reuse agentic.dev's outer Dockerfile for inner sandboxes: it carries outer-only concerns (docker-outside-of-docker, claude-persist) that an inner sandbox never uses, and it lacks per-project toolchains.

## Consequences

- Trivial JS/TS projects need no custom inner Dockerfile — the sandcastle default suffices.
- Toolchain-heavy projects own a `.sandcastle/Dockerfile`; the per-language `devcontainer-*` images become reusable bases for agent environments, keeping human-dev and agent toolchains in parity.
- Inner images stay lean — no nested docker, no orchestration tooling.

## Addendum (2026-07-06): `devcontainer-*` derivation guidance is stale

The original guidance above — derive a toolchain-heavy project's inner Dockerfile
`FROM` the matching sibling `devcontainer-*` image in this workspace
(rust/python/dotnet/vue) — was never executed. No inner Dockerfile in this repo
derives from one, and none of those sibling repos has ever grown a
`.sandcastle/` directory. On reflection it's also the wrong default: those
images are heavy VS-Code-devcontainer bases (e.g.
`mcr.microsoft.com/vscode/devcontainers/dotnet:8.0`), built for human editors
with debuggers/extensions, not minimal agent sandboxes — and requiring a
sibling repo to exist and stay in sync is an unnecessary coupling.

**Superseded by:** derive per-language `.sandcastle/Dockerfile.<lang>` variants
from the lean official upstream SDK image for that language instead (e.g.
`mcr.microsoft.com/dotnet/sdk:8.0`, `rust:1-slim`, `python:3.12-slim`),
matching the existing `Dockerfile`/`Dockerfile.opencode` pattern: install
`git` + `curl`, create/rename the non-root `agent` user with matching UID/GID
build-args, `curl -fsSL https://claude.ai/install.sh | bash` (the native
installer — confirmed Node-independent, so it works unmodified on a non-Node
base image), no nested Docker or orchestration tooling.

See `docs/adr/0024-sandcastle-is-not-a-language-constraint.md` for why this
stays a Dockerfile-only concern rather than a sandcastle engine swap. No
per-language Dockerfile has been built yet under either the original or
corrected guidance — that remains separate follow-up work.
