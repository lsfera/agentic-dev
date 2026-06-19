# Operational details: sandbox cleanup, webhook safety, .sandcastle layout

Closing decisions for three mechanical concerns left after the architecture was settled. None is a real fork; each records the obvious-but-load-bearing choice.

## Inner sandbox cleanup

Inner agentic sandboxes are host-daemon siblings under docker-outside-of-docker, so they don't die with the outer devcontainer.

- Each run calls `sandbox.close()` in a `finally` so a normal teardown always happens.
- Inner sandboxes carry a label (e.g. `agentic.sandcastle=1`). The listener runs a label-scoped prune on startup and shutdown — `docker rm -f` of any matching container it isn't tracking — mirroring how agentic.dev's `down.sh` already scopes teardown by label. This catches orphans left if the listener died mid-run.

## Webhook safety and dedupe

- The smee/webhook payload is validated against a shared HMAC secret before processing; the channel URL and secret are treated as sensitive.
- Side effects are made idempotent: relabeling is naturally idempotent, but **starting a sandbox is not**. Before acting on a merge event the listener checks live issue/PR state, and dedupes on PR number / merge-commit SHA / delivery id. On restart it re-derives the ready-set from GitHub (ADR-0008 backstop) and treats already-merged PRs as processed.

## .sandcastle/ location and main.ts

- `.sandcastle/` lives **per mounted project**, inside the project folder bound at `/workspaces/<folder>` — consistent with the per-project Dockerfile in ADR-0002.
- The orchestration logic (listener, queue derivation, sandbox spin-up) is a **generic shared core**; only configuration (Dockerfile, env, prompts) is per-project. Projects don't each reimplement the loop.
