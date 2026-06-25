# Give inner sandboxes an MTU-corrected network

Both agent tiers produced empty "Agent started → Agent stopped" turns (0 commits) when driven through the orchestrator (#48), while the same agents worked standalone. After ruling out CLAUDE.md, auth/token, stdin delivery, OOM, the SDK entrypoint, the binary, env vars, and usage quota (the same token returns a full turn on the host and inside the `agentic-dev` devcontainer), the cause was localized to the **inner sandbox container's network**.

## Root cause (validated 2026-06-25)

Docker Desktop's **default bridge advertises MTU 65535**, while the real container→VM→host→internet path is ~1400 bytes, and PMTUD is black-holed. So small requests pass (a `curl` 401, `/api/tags`) but the agent's **streaming** responses stall after the first chunk — the Anthropic API stream for the claude tier, the host Ollama stream for the local tier. claude emits only its `system/init` line then exits; opencode likewise produces nothing. Every iteration is an empty turn.

Empirically, on a `sandcastle:local` sibling container:

| MTU | 200 KB download | 10 MB download | claude turn |
|-----|-----------------|----------------|-------------|
| 65535 (default bridge) | stalls | stalls | init-only |
| 1500 (custom net) | ok | stalls | init-only |
| **1400 (custom net)** | ok | **2.6 s** | **full PONG** |

`agentic-dev` (the compose service, MTU 1500) works because its path has no extra encapsulation; the DooD sibling containers do, so they need ~100 bytes of headroom → **1400**.

A daemon-level fix (`daemon.json` top-level `"mtu"`) was tried and **rejected** — Docker Desktop's engine fails to start with it. So the fix lives in the orchestrator, not the daemon.

## Decision

The orchestrator creates an MTU-corrected Docker network at startup and attaches every inner sandbox to it:

- `ensureSandboxNetwork(name, mtu, exec)` in `main.ts` idempotently runs `docker network create --opt com.docker.network.driver.mtu=<mtu> <name>` (skips if it already exists). Best-effort: on failure the run falls back to the default network.
- `SandboxRunner` accepts a `network` option and passes it to sandcastle's `docker({ network })`.
- Defaults: `AGENTIC_SANDBOX_NETWORK=agentic-sandbox-net`, `AGENTIC_SANDBOX_MTU=1400` (both overridable via env).

`host.docker.internal` still resolves on the custom network (to the Docker Desktop gateway `192.168.65.254`), so the local tier keeps reaching Ollama.

## Consequences

- Both tiers complete turns through the orchestrator — verified end-to-end: the claude tier implemented a trivial issue, committed, and signalled completion on the MTU-1400 network (it empty-turned on the default network).
- No daemon/Docker-Desktop reconfiguration required; the network is created on demand and is project-agnostic.
- If a future host has a different path MTU (e.g. a VPN with more overhead), lower `AGENTIC_SANDBOX_MTU`.
- The network is shared across projects/runs; it carries no project state, so this does not interact with the #40 project-scoped sweep.
