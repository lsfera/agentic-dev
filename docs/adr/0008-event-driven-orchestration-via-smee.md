# Event-driven orchestration via a smee.io webhook proxy

The orchestrator reacts to GitHub `PR merged` events: a merge relabels dependents and triggers the next agentic sandbox. Because the outer devcontainer is behind NAT and GitHub cannot POST to it directly, a smee.io (or equivalent) channel relays real webhooks into a persistent listener running inside the outer devcontainer.

This revises ADR-0006: `/afk` no longer launches a one-shot `npx tsx main.ts` that exits — it starts a **persistent listener** that lives in the outer devcontainer (which already runs `sleep infinity`) until the queue drains or it is stopped.

## Decisions

- **Bridge:** smee.io channel relays GitHub webhooks to the in-container listener. The webhook secret is validated on receipt; the channel URL is treated as sensitive.
- **Backstop:** webhook deliveries can be missed, so on startup and periodically the listener re-derives the ready-set from live GitHub state (labels + merged status) rather than trusting the event stream alone.

## Consequences

- Lowest-latency unblocking of dependents; multi-layer graphs clear as merges land.
- A third-party relay sits in the loop and repo events transit it — accepted for a local single-seat dev setup.
- The orchestrator is now a long-lived process, not a script; stopping `/afk` means stopping that listener.
