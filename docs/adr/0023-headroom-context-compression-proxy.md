# Headroom context-compression proxy

An opt-in, off-by-default integration with `headroom-ai` that shrinks the token footprint of agent sandbox runs two ways: a one-shot compression of the initial prompt (`context-compressor.ts`, landed quietly in PR #85), and — new here — routing the inner sandbox's *entire* live Claude Code session through a local `headroom proxy` container so every turn, not just the first, is compressed. Both are gated by `HEADROOM_MODE` (`off` by default) and require the adopter to run their own proxy; nothing about this is on by default or required.

## Motivation

Long-running `/afk` sandboxes (multi-turn, tool-heavy, sometimes 12+ iterations per issue) accumulate large conversation histories, which cost tokens on every subsequent turn. `headroom-ai` claims 60–95% token reduction via its compression proxy. The one-shot prompt compression already in this repo only touches the *first* turn — the bulk of a long session's cost is everything after that, which this ADR's inner-sandbox routing addresses.

## Why a proxy, not the SDK wrapper

`headroom-ai`'s JS/Python SDKs offer two integration shapes:

- **Client-side wrapping** (`withHeadroom(new Anthropic())`) — intercepts messages before an SDK call, POSTs them to the proxy's `/v1/compress` endpoint for compression, then sends the (now smaller) messages to Anthropic directly via the wrapped client. This is what `context-compressor.ts` already does, manually, for the initial prompt.
- **Transparent reverse proxy** (`ANTHROPIC_BASE_URL=http://localhost:8787 claude`, confirmed via headroom's own docs) — the CLI's *entire* outbound traffic is redirected at the client through a real Anthropic Messages API-compatible endpoint that compresses and forwards to the real API, returning genuine responses. No SDK wrapping, no code change inside the CLI.

The inner sandbox runs the *Claude Code CLI itself*, not a hand-rolled SDK call this repo controls — there's no call site to wrap. The reverse-proxy shape is the only one that reaches live, in-CLI traffic, so that's what's wired into `sandbox-runner.ts`.

## Design

- **Proxy image:** `ghcr.io/chopratejas/headroom:latest` (port 8787, matches the client's own `DEFAULT_BASE_URL`), run as an opt-in `docker-compose.yml` service (`profiles: ["headroom"]`, `docker compose --profile headroom up`) — not always-on, since `HEADROOM_MODE` defaults to `off` and most runs never touch it.
- **Two separate reachability paths, because two separate containers need it:**
  - The **outer devcontainer** (running `context-compressor.ts`'s one-shot `compress()` calls) resolves the proxy by compose-internal DNS — `HEADROOM_BASE_URL` defaults to `http://headroom:8787`.
  - The **inner sandbox** is a docker-outside-of-docker *sibling* container on `agentic-sandbox-net` (ADR-0013), a completely different Docker network than the compose project's `devcontainer-network` — it cannot resolve `headroom` by service name. It reaches the proxy via `host.docker.internal:8787`, the same mechanism the local/Ollama tier already depends on (`ensureSandboxNetwork`, `main.ts`). This requires the proxy's port to be published to the host loopback (`ports: ["8787:8787"]`), not just exposed on the compose network.
- **Injection point:** `sandbox-runner.ts`'s `buildAgentInput` sets `claudeCode(model, { env: { ANTHROPIC_BASE_URL: "http://host.docker.internal:8787" } })` when `isCompressionActive()` is true. Uses sandcastle's existing `ClaudeCodeOptions.env` field (previously unused in this repo) — no new plumbing needed in sandcastle itself.
- **Scope: implementing agent only.** `reviewer-adapter.ts` is untouched. Unlike ADR-0022's memory-retrieval exclusion (bias risk), this is a data-exposure decision: the reviewer's data path (code diffs, review reasoning) is kept out of a third-party proxy's traffic by default, consistent with treating reviewer input more conservatively.
- **Credentials:** the proxy performs compression by calling an LLM itself, so it needs its own `ANTHROPIC_API_KEY` (forwarded into the `headroom` service) — `CLAUDE_CODE_OAUTH_TOKEN` (the subscription flow this repo defaults to, ADR-0003) does not work for the proxy's own credential. A subscription-only adopter can still run everything else in this repo; they simply have no key to give the proxy, and compression silently no-ops (see Consequences).

## Consequences

- **Unverified: OAuth-through-proxy.** Whether Claude Code's `CLAUDE_CODE_OAUTH_TOKEN` subscription-OAuth flow survives being routed through a third-party `ANTHROPIC_BASE_URL` has not been live-tested. If it doesn't, `HEADROOM_MODE` is effectively unusable for subscription-only adopters even with the proxy running — this needs a live smoke test before being relied on in production.
- **Silent no-op on misconfiguration.** `headroom-ai`'s client falls back to `{ compressed: false }` on any connection failure rather than throwing (`makeFallbackResult`) — a proxy that isn't running, isn't published to the host, or lacks a valid `ANTHROPIC_API_KEY` degrades to uncompressed traffic with no visible error. This matches this repo's general fail-open philosophy (ADR-0022) but means a broken proxy is invisible unless someone is watching token usage.
- **New external image dependency.** `ghcr.io/chopratejas/headroom` is a third-party image outside this repo's own GHCR namespace, pulled only when a user opts into the `headroom` compose profile. Off by default; no supply-chain exposure for adopters who never opt in.
- **Trust boundary widens when enabled.** With `HEADROOM_MODE` on, the *entire* live agent session — tool output, file contents, everything — flows through the proxy, not just the initial prompt. This is a materially larger exposure than the pre-existing one-shot `compress()` call, and is why it stays opt-in rather than becoming a new default.

## Addendum (2026-07-05): Credentials bullet and OAuth-through-proxy consequence are stale

Both the **Credentials** design bullet and the **"Unverified: OAuth-through-proxy"** consequence above were written against an assumption — that the proxy calls an LLM itself to perform compression, so it needs its own `ANTHROPIC_API_KEY` — that no longer holds for the pinned `ghcr.io/chopratejas/headroom:latest` image (running version `0.27.0` at time of writing). This was corrected via direct source inspection of the running container plus a live round-trip test, not guesswork:

- `headroom/proxy/auth_mode.py` classifies every inbound request into `PAYG` / `OAUTH` / `SUBSCRIPTION`. A Claude Code CLI request (`User-Agent: claude-cli/...`, `Authorization: Bearer sk-ant-oat-...`) is explicitly classified `SUBSCRIPTION` — a first-class supported case, not an edge case.
- `headroom/proxy/handlers/anthropic.py` forwards the inbound request's own `Authorization` header upstream to Anthropic **unchanged** (stripping only hop-by-hop and internal `x-headroom-*` headers). The proxy's own `ANTHROPIC_API_KEY` env var is never consulted on this path.
- The compression transforms themselves (`smart_crusher.py`, `kompress_compressor.py`) run a **local ONNX model** (cached via HuggingFace Hub), not a live call to the Anthropic API — so no LLM credential is needed for compression at all, in any auth mode. `transforms/compression_policy.py` does give `SUBSCRIPTION` mode its own (more conservative) `max_lossy_ratio` cap, but that's a policy hedge, not a credential requirement.
- Live-tested: two direct `POST /v1/messages` calls to the proxy, authenticated with only `CLAUDE_CODE_OAUTH_TOKEN` (no `ANTHROPIC_API_KEY` presented in the request) and a `claude-cli/` User-Agent, both returned genuine `200` responses from real Anthropic infra (real `msg_...` ids, real token usage) and were correctly attributed to `agent: "claude-code"` in the proxy's own `/stats` output.

**So:** a subscription-only adopter (no `ANTHROPIC_API_KEY` at all) can use `HEADROOM_MODE` today, at least for the reverse-proxy path this ADR wires up. The `ANTHROPIC_API_KEY` passthrough in `docker-compose.yml`'s `headroom` service is not required for this to work and can be treated as optional.

**Why this drifted silently:** the compose file pins `ghcr.io/chopratejas/headroom:latest` rather than a version tag, so the proxy's behavior can (and did) change out from under this ADR's assumptions without anyone noticing. Consider pinning to a specific version tag to make future behavior changes an explicit, reviewable bump rather than a silent one.

**Not re-verified by this addendum:** whether compression itself (not just auth) reliably fires on real multi-turn agent sessions in `SUBSCRIPTION` mode — the live test above used single-shot requests with synthetic content that didn't trigger the compressors (`0` requests compressed in `/stats`, matching the "no compressible content" bucket). The auth question this ADR flagged as unverified is now verified; the compression-effectiveness question from issue #100 is a separate, already-documented finding (see that issue and the `headroom-compression-investigation` memory).
