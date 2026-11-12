# Architecture Decision Records

Current-state summary: [../architecture.md](../architecture.md). ADRs record *why*;
they are not rewritten when code moves, but each carries a **Status** line.
Records that were fully absorbed by a successor are removed (history is in git):

- former **ADR-0006** (`/afk` wraps sandcastle via `/exec`) → merged into [ADR-0005](0005-sandcastle-replaces-afk-issues-stay-the-queue.md)
- former **ADR-0007** (auto-merge on green CI) and **ADR-0009** (`/hitl` is a merge gate only) → merged into [ADR-0020](0020-review-gate-before-auto-merge.md)
- former **ADR-0010** (sandbox cleanup, webhook safety, `.sandcastle/` location) → merged into [ADR-0008](0008-event-driven-orchestration-via-smee.md) and [ADR-0027](0027-sandcastle-directory-layout.md)

## Foundations: sandboxes, auth, git

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-git-isolated-agentic-sandboxes.md) | Agentic sandboxes exchange code via git, not bind mounts | Accepted. The "no bind mount" consequence was withdrawn by ADR-0011. |
| [0002](0002-lean-inner-image-per-project-extension.md) | Inner agentic-sandbox image is sandcastle's lean default, extended per-project | Accepted. The per-project extension mechanism is superseded by ADR-0025. |
| [0003](0003-subscription-seat-shapes-auth-and-concurrency.md) | A single subscription seat shapes Claude auth injection and concurrency | Accepted. |
| [0004](0004-inner-sandbox-git-push-via-readonly-ssh.md) | Inner sandboxes push via a read-only SSH key mount | Accepted (design); currently the orchestrator pushes from the outer container, see the status section below and ADR-0026. |
| [0026](0026-outer-devcontainer-uses-host-ssh-agent.md) | Outer devcontainer authenticates git via the host's ssh-agent, not a ~/.ssh mount | Accepted. Supersedes the `~/.ssh` mount premise noted in ADR-0004. |

## Orchestration and merge policy

| ADR | Title | Status |
|-----|-------|--------|
| [0005](0005-sandcastle-replaces-afk-issues-stay-the-queue.md) | Sandcastle replaces /afk, launched via /exec; GitHub issues stay the durable queue | Accepted. Absorbs the former ADR-0006. Implementation style superseded by ADR-0028. |
| [0008](0008-event-driven-orchestration-via-smee.md) | Event-driven orchestration via a smee.io webhook proxy | Accepted. Revises the launch model in ADR-0005. Absorbs the former ADR-0010. |
| [0019](0019-lean-execution-layer-high-level-sandcastle-lifecycle.md) | Lean execution layer — high-level sandcastle lifecycle | Accepted. The Promise-based style is superseded by ADR-0028 (behaviour unchanged). |
| [0020](0020-review-gate-before-auto-merge.md) | `/afk` merge policy: AI review gate, then auto-merge on green CI | Accepted. Absorbs the former ADR-0007 and ADR-0009. |
| [0021](0021-durable-agent-lifecycle-labels.md) | Durable agent lifecycle labels | Accepted. |
| [0022](0022-cross-run-agent-memory.md) | Cross-run agent memory | Accepted. |
| [0028](0028-effect-4-orchestrator.md) | The orchestrator is built on Effect 4 | Accepted. Supersedes the async/await style of ADR-0005/0019. |
| [0029](0029-upstream-skills-via-claude-plugin.md) | Install upstream skills as a Claude Code plugin, not a build-time clone | Accepted. Supersedes the skills half of ADR-0017. |

## Devcontainer and images

| ADR | Title | Status |
|-----|-------|--------|
| [0011](0011-path-match-the-outer-mount.md) | Fix the DooD path trap by path-matching the outer mount | Accepted. |
| [0012](0012-self-contained-per-project-devcontainer.md) | Self-contained per-project devcontainer | Accepted. Supersedes the shared-`.devcontainer` premise of earlier ADRs. |
| [0013](0013-mtu-corrected-sandbox-network.md) | Give inner sandboxes an MTU-corrected network | Accepted. |
| [0014](0014-prebuilt-ghcr-sandbox-images.md) | Publish prebuilt inner sandbox images to GHCR | Accepted. |
| [0015](0015-prebuilt-outer-orchestrator-image.md) | Publish the prebuilt outer orchestrator image to GHCR | Accepted. |
| [0016](0016-bake-orchestrator-into-outer-image.md) | Bake the orchestrator into the outer image | Accepted. |
| [0017](0017-bake-workflow-commands-and-upstream-skills.md) | Bake the workflow commands and upstream skills into the outer image | Accepted; skills half superseded by 0029. |
| [0018](0018-cockpit-mode-drive-from-inside-the-outer-image.md) | Cockpit mode — drive the workflow from inside the outer image | Accepted. |
| [0027](0027-sandcastle-directory-layout.md) | `.sandcastle/` is organised into `src/`, `docker/` and `prompts/` | Accepted. |

## Optional capabilities and languages

| ADR | Title | Status |
|-----|-------|--------|
| [0023](0023-headroom-context-compression-proxy.md) | Headroom context-compression proxy | Accepted. |
| [0024](0024-sandcastle-is-not-a-language-constraint.md) | Sandcastle is not a language constraint — no engine change for multi-language support | Accepted. |
| [0025](0025-per-language-skills-via-onsandboxready.md) | Inject per-language skills via onSandboxReady, not per-language Dockerfiles | Accepted and implemented (`SANDCASTLE_SKILLS_DIR`). |

