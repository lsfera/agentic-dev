# A single subscription seat shapes Claude auth injection and concurrency

Claude is driven by a Max/Pro subscription (OAuth), not an API key. Inner agentic sandboxes therefore reuse the OAuth credentials agentic.dev already persists at `~/.claude` (via claude-persist). This single seat, not Docker, is the binding constraint on parallelism.

## Decisions

- **Credential injection uses sandcastle's native `CLAUDE_CODE_OAUTH_TOKEN` env var, not a `~/.claude` mount.** sandcastle's `.env.example` documents this: run `claude setup-token` on the host to mint a subscription OAuth token, then inject it as `CLAUDE_CODE_OAUTH_TOKEN` (via `.sandcastle/.env` or the agent provider's `env`). This supersedes the earlier plan to bind-mount the persisted `~/.claude` directory — there is no path-translation gotcha and no refresh-writeback divergence, because the token is a self-contained env value, not a credential file the agent rewrites. _(Original plan, now withdrawn: mount the persisted `~/.claude` read-only per run.)_
- **Concurrency is a per-run knob, defaulting to serial.** The orchestrator runs one agentic sandbox at a time by default, staying within a single subscription's rate limits and ToS norms. The pool can be raised per run when headroom is known; the loop supports both paths and handles rate-limit responses gracefully when raised.

## Validated (Beat 2, 2026-06-19)

An autonomous `claudeCode` agent ran inside the inner sandbox using only `CLAUDE_CODE_OAUTH_TOKEN` (from `.sandcastle/.env`, minted via `claude setup-token`) — no `ANTHROPIC_API_KEY` — and committed to `spike/beat-2`, visible on the host. Subscription auth in the inner sandbox works.

**Finding — needs a completion signal.** With `maxIterations: 3` and no `completionSignal`, the agent ran all 3 iterations and appended its line twice (two duplicate commits). The real orchestrator must pass a `completionSignal` (and/or tighter `maxIterations`) so agents stop when done rather than looping and duplicating work. Relevant to the `/afk` loop (ADR-0007/0008).

## The agent backend is a pluggable tier — local Ollama validated (2026-06-19)

The model/agent is orthogonal to the sandbox. Beat 2-ollama proved a **local** backend works end-to-end: agent provider `opencode("ollama/qwen3-coder:30b")`, an inner image with the OpenCode CLI (`sandcastle-opencode:local`), an `opencode.json` provider block (`@ai-sdk/openai-compatible`, `baseURL: http://host.docker.internal:11434/v1`) copied into the worktree, and host Ollama bound to `0.0.0.0:11434`. The agent ran in the inner sandbox and committed to `spike/beat-2-ollama` using **no Claude subscription**.

This makes "which brain" a **per-run tier knob** alongside model + concurrency:
- **Local Ollama tier** (e.g. `qwen3-coder:30b`) — free, private, **no seat/rate limit so it relaxes the single-seat concurrency cap above** for the work routed to it. Good for cheap/mechanical issues and for testing the loop. Quality/reliability on hard autonomous coding is below Sonnet/Opus — keep it a tier, not the default.
- **Claude subscription tier** (`claudeCode`, `CLAUDE_CODE_OAUTH_TOKEN`) — the default for real implementation work.

Cost of the local tier: a separate inner image (the chosen CLI must be installed), an `opencode.json` (or codex equivalent), and host→sandbox network reachability (`host.docker.internal`, Ollama on `0.0.0.0`).

## Consequences

- git-isolation (ADR-0001) makes parallel sandboxes *mechanically* safe, but the subscription seat makes them *practically* limited — serial is the safe default.
- No API billing surface; cost is the existing subscription.
