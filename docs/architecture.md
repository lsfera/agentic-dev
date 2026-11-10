# Architecture (current state)

The single description of how agentic-dev works **today**. Decisions and their
rationale live in [`docs/adr/`](adr/README.md); this page states the result and links
the ADR behind each point. Terms are defined in [CONTEXT.md](../CONTEXT.md); setup and
usage are in the [README](../README.md); the agent operating contract is
[CLAUDE.md](../CLAUDE.md).

## Layers

| Layer | What | Notes |
|-------|------|-------|
| Definition | `/grill-me-with-docs` → `/to-prd` → `/to-issues` | Produces GitHub issues as vertical slices; GitHub issues are the only durable state (ADR-0005) |
| Driver | Claude Code, **host-driven** (via `/exec` + docker MCP) or **cockpit** (inside the outer devcontainer) | `/exec` is the single shell boundary and detects context via `AGENTIC_IN_CONTAINER` (ADR-0005, ADR-0018) |
| Orchestrator | Effect 4 program in `.sandcastle/src/`, built on sandcastle, run by `afk` / `hitl` → `.sandcastle/run.sh` | Long-lived listener, runs in the outer devcontainer (ADR-0005, ADR-0008, ADR-0028) |
| Agentic sandbox | Disposable inner container per issue (Claude tier or opencode/Ollama tier) | Git-isolated; sibling container via docker-outside-of-docker (ADR-0001, ADR-0019) |

## Outer devcontainer

- **Self-contained per project**: each project holds its own `.devcontainer/`; the container is named per project (`DEVCONTAINER_NAME`) (ADR-0012).
- **Path-matched mount**: the workspace is also bind-mounted at its absolute host path and the orchestrator runs from there, so sandcastle worktrees resolve correctly for sibling containers (ADR-0011).
- **Published image** (`ghcr.io/lsfera/agentic-dev/devcontainer`) bakes the orchestrator, workflow slash commands and four upstream skills; the compose file boots standalone with fallbacks for every variable (ADR-0015, 0016, 0017).
- **Git auth** uses the host ssh-agent socket, not a `~/.ssh` mount (ADR-0026).
- **Claude state** persists on the host in `~/.devcontainer-claude/`.

## Inner sandboxes

- **Code crosses the boundary via git**, not bind mounts: each sandbox gets its own checkout and commits to `agent/issue-<N>` (ADR-0001). Today the orchestrator pushes and opens the PR; inner push via read-only SSH remains the design target (ADR-0004).
- **Images**: sandcastle's lean default, published to GHCR (`sandbox`, `sandbox-opencode`) or built locally from `.sandcastle/docker/` (ADR-0002, ADR-0014). Per-language tooling is injected via `onSandboxReady` skills rather than per-language Dockerfiles (ADR-0024, ADR-0025).
- **Network**: attached to an MTU-corrected network created by the orchestrator (ADR-0013); the DooD socat proxy is bypassed via `resolveDockerHost` (ADR-0019).
- **Lifecycle**: `createSandbox` + `await using`; labelled sandboxes are swept on startup and shutdown (ADR-0008, ADR-0019).
- **Auth and concurrency**: Claude subscription OAuth token via `CLAUDE_CODE_OAUTH_TOKEN`; execution is serial because one seat shapes concurrency (ADR-0003).

## Issue → merge pipeline

1. `ready-for-agent` issue is claimed → label `agent:in-progress` (ADR-0021).
2. Sandbox implements with `/tdd`, commits, and a PR is opened → `agent:in-review`.
3. **`/afk`**: a read-only reviewer sandbox returns `pass` or `changes-requested` (a failure resolves to `changes-requested`). `pass` enables GitHub-native auto-merge, which lands when required CI is green (ADR-0020). **`/hitl`**: no review sandbox; the PR waits for a human merge (ADR-0020).
4. A `PR merged` webhook (smee.io relay) unblocks dependents; a periodic re-derivation from live GitHub state is the backstop for missed deliveries. The HMAC signature is advisory because smee re-serialises bodies (ADR-0008).
5. Failures re-label the issue `ready-for-agent` up to `maxRetries` (default 2) per run; startup reconciles any leftover `agent:*` labels from a crashed run (ADR-0021).

State transitions are pure functions in `reduce.ts`; the orchestrator (`main.ts`) carries out the emitted actions. Adapters (`IssueSource`, `SandboxRunner`, `ReviewerAdapter`, memory store) return Effects with typed errors (ADR-0028).

## Optional subsystems

- **Cross-run memory**: pinned `agent:memory` issue, category-filtered and injected into prompts (ADR-0022).
- **Context compression**: opt-in headroom proxy via a compose profile (ADR-0023).
- **Local tier**: opencode + host Ollama (`afk local [model]`) (README, ADR-0019).

## Repository layout

```
.devcontainer/   outer image, compose, init.sh, cockpit, afk/hitl launchers
.sandcastle/     src/ (orchestrator + tests), docker/ (inner images), prompts/, run.sh, config   (ADR-0027)
.claude/commands slash commands (baked into the published image)
docs/            this page, prd.md, adr/
examples/        copy-pasteable orchestrator configurations
```
