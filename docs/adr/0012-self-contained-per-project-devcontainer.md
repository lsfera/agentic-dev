# Self-contained per-project devcontainer

Supersedes the "one shared `.devcontainer` serves every project; each project is a subfolder" premise that earlier ADRs and `up.sh` assumed.

## Context

The original model kept a single `.devcontainer/` at this repo's root and ran every project as a subfolder bound at `/workspaces/<folder>`. Making that work needed two pieces of glue:

- `up.sh` passed `--config .devcontainer/devcontainer.json` because the devcontainer CLI only auto-discovers a `.devcontainer/` *inside* the workspace folder, not one level up.
- The `initializeCommand` either honoured an exported `AGENTIC_DC_INIT` (set by `up.sh`) or walked up the directory tree to find `init.sh`. VS Code *Reopen in Container* couldn't set that variable, so it relied on the fragile walk-up.

Two consequences pushed us off this model: VS Code *Reopen in Container* never worked cleanly, and the fixed `container_name: agentic-sandbox` meant only one sandbox could exist at a time, blocking concurrent projects (a prerequisite for #40's project-scoped orphan sweep).

## Decision

Make each project **self-contained**: the workspace folder *is* the project root, and it holds its own `.devcontainer/`.

- `devcontainer.json`'s `initializeCommand` runs the in-project `${localWorkspaceFolder}/.devcontainer/init.sh` directly — no `AGENTIC_DC_INIT`, no walk-up (#41).
- `init.sh` derives a per-project `DEVCONTAINER_NAME` from the workspace folder basename (sanitized to Docker's container charset, alphanumeric first char) and writes it to `.env`; `docker-compose.yml` uses `container_name: ${DEVCONTAINER_NAME}`. A side-effect-free `--dry-run` mode prints the derived names for tests.
- `up.sh` becomes a thin `devcontainer up` wrapper: no `--config`, no `imageConfigs` patching (the devcontainer CLI records the workspace folder in container metadata, so GUI attach lands natively). It keeps a testable `--dry-run` (#42).

The shell-derived names are regression-guarded by `init-sh.test.ts` / `up-sh.test.ts` at the same `--dry-run` seam as `run-sh.test.ts`.

## Consequences

- **VS Code *Reopen in Container* works natively** — open the project folder, reopen, done. No launcher script required.
- **Concurrent projects** — per-project container names mean two projects can run side by side; this is what lets #40's sweep be project-scoped.
- **The docker MCP map is per-project.** `/exec` targets `ALLOWED_CONTAINERS=devcontainer:<DEVCONTAINER_NAME>`; for this repo that is now `agentic-dev`, not the old fixed `agentic-sandbox`. Host MCP config must be updated to match.
- **Config-duplication tradeoff.** Each project keeps its own copy of `.devcontainer/`. Improvements to the shared config no longer land everywhere at once — they must be propagated to each project (re-copy or templating). We accept this for native discovery and concurrency; a future templating/`init` command could ease propagation.
- The path-match mount (ADR-0011) is *simpler* under this model: project root = the mount = the config location. See the note added there.
