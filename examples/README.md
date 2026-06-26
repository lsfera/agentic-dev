# Example configurations

Concrete, copy-pasteable setups by use case. Each directory holds the config
files that differ for that scenario (mainly `orchestrator.env`) plus a short
README with the run command. Copy the files into `.sandcastle/` (and follow the
per-example notes), then launch with `afk` / `hitl`.

| Use case | Directory | Tier | Inner image | Notes |
|----------|-----------|------|-------------|-------|
| Standard — just run it with Claude | [`claude-prebuilt/`](claude-prebuilt/) | claude | prebuilt GHCR `:latest` | no local image build |
| Offline / no API cost | [`local-ollama/`](local-ollama/) | local (opencode) | prebuilt GHCR `:latest` | needs host Ollama |
| Contributor / air-gapped / custom image | [`build-from-source/`](build-from-source/) | claude | built `:local` | builds images yourself |
| Reproducible — lock versions | [`pinned-reproducible/`](pinned-reproducible/) | claude | pinned `:vX.Y.Z` | inner **and** outer image pinned |
| Many issues in parallel | [`parallel-throughput/`](parallel-throughput/) | claude | prebuilt GHCR `:latest` | `AGENTIC_CONCURRENCY` > 1 |

## Common to every example

- **`GH_TOKEN`** (in `orchestrator.env`) — the orchestrator's own `gh` token for
  issue list/label/comment and PR create. On the host: `gh auth token`. It stays
  in `orchestrator.env` so it never reaches the inner sandboxes.
- **Claude tier** also needs `.sandcastle/.env` with `CLAUDE_CODE_OAUTH_TOKEN`
  (mint with `claude setup-token`). The **local** tier doesn't.
- **`AGENTIC_REPO`** is optional — omit it to act on the repo `gh` detects from the
  working directory; set `owner/name` to target another repo.
- **Run mode** is chosen by the launcher, not the env: `afk` (autonomous) or
  `hitl` (approve between issues). Every example works with either.

See the repository README for the bigger picture (tiers, the prebuilt images, and
the `afk`/`hitl` launchers).
