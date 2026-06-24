# Event-driven orchestration via a smee.io webhook proxy

The orchestrator reacts to GitHub `PR merged` events: a merge relabels dependents and triggers the next agentic sandbox. Because the outer devcontainer is behind NAT and GitHub cannot POST to it directly, a smee.io (or equivalent) channel relays real webhooks into a persistent listener running inside the outer devcontainer.

This revises ADR-0006: `/afk` no longer launches a one-shot `npx tsx main.ts` that exits — it starts a **persistent listener** that lives in the outer devcontainer (which already runs `sleep infinity`) until the queue drains or it is stopped.

## Decisions

- **Bridge:** smee.io channel relays GitHub webhooks to the in-container listener. The unguessable channel URL is the trust boundary and is treated as sensitive.
- **Signature is advisory, not a gate (revised, #26):** GitHub's HMAC is computed over the raw request bytes, but smee re-parses and re-serializes the body before relaying it, so the original bytes are gone. Re-stringifying the parsed body matches GitHub's signature for most payloads but not all — JSON number reformatting (`1.0`→`1`, `5e2`→`500`) makes a strict HMAC reject genuine deliveries. The listener therefore computes the signature verdict for observability and logs it, but **never rejects on it**; the secret channel URL is what gates access. To restore strict HMAC as a gate, replace smee with a raw-body-preserving relay.
- **Backstop:** webhook deliveries can be missed, so on startup and periodically the listener re-derives the ready-set from live GitHub state (labels + merged status) rather than trusting the event stream alone.

## Consequences

- Lowest-latency unblocking of dependents; multi-layer graphs clear as merges land.
- A third-party relay sits in the loop and repo events transit it — accepted for a local single-seat dev setup.
- Security rests on the secrecy of the channel URL rather than per-delivery HMAC; anyone who learns the URL can inject events. Acceptable for a single-seat dev setup; revisit (raw-body relay) if this graduates to a shared/production deployment.
- The orchestrator is now a long-lived process, not a script; stopping `/afk` means stopping that listener.
