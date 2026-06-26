# Offline: local Ollama tier

Implement issues with a local Ollama model via [opencode](https://opencode.ai) —
no API cost, fully offline. Quality depends on the model, so it's best for cheap
parallel work, not yet a drop-in for Claude on hard slices.

## Prerequisites

- Ollama on the host, bound to `0.0.0.0:11434` so containers reach it at
  `http://host.docker.internal:11434`.
- A coding model pulled, e.g. `ollama pull qwen3-coder:30b` (keep weights
  ~15–22 GB so RAM stays free for Docker + the sandbox stack).

## Setup

```bash
cp examples/local-ollama/orchestrator.env .sandcastle/orchestrator.env
cp examples/local-ollama/opencode.json    opencode.json   # repo root; the model map
# then edit .sandcastle/orchestrator.env → set GH_TOKEN
```

`opencode.json` points opencode at the host Ollama and lists the available
models; add a model by pulling it in Ollama and adding it to the `models` map.
Verify reachability from a container:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway curlimages/curl \
  -s http://host.docker.internal:11434/api/tags
```

## Run

```bash
afk local                       # uses AGENTIC_LOCAL_MODEL
afk local qwen2.5-coder:32b     # override the model for this run
hitl local                      # review between issues
```
