# Inner agentic-sandbox image is sandcastle's lean default, extended per-project

The inner sandbox image is kept separate from the outer devcontainer image. The baseline is sandcastle's default `.sandcastle/Dockerfile` (Node 22 + git + gh + Claude Code CLI as non-root), which covers JS/TS work. Toolchain-heavy projects derive their own `.sandcastle/Dockerfile` `FROM` the matching `devcontainer-*` image in this workspace (rust/python/dotnet/vue) and layer the Claude CLI on top.

We deliberately do **not** reuse agentic.dev's outer Dockerfile for inner sandboxes: it carries outer-only concerns (docker-outside-of-docker, claude-persist) that an inner sandbox never uses, and it lacks per-project toolchains.

## Consequences

- Trivial JS/TS projects need no custom inner Dockerfile — the sandcastle default suffices.
- Toolchain-heavy projects own a `.sandcastle/Dockerfile`; the per-language `devcontainer-*` images become reusable bases for agent environments, keeping human-dev and agent toolchains in parity.
- Inner images stay lean — no nested docker, no orchestration tooling.
