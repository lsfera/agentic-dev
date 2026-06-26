# Parallel: many issues at once

Drive several `ready-for-agent` issues simultaneously. Each runs in its own
disposable, git-isolated sandbox; `AGENTIC_CONCURRENCY` caps how many run at the
same time. Best when you have a backlog of independent slices and host headroom.

## Setup

```bash
cp examples/parallel-throughput/orchestrator.env .sandcastle/orchestrator.env
# then edit .sandcastle/orchestrator.env → set GH_TOKEN (and AGENTIC_CONCURRENCY)

printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(claude setup-token)" > .sandcastle/.env
```

## Sizing

- Each concurrent sandbox is a full container — scale `AGENTIC_CONCURRENCY` to
  host CPU/RAM. Start at 2–4 and watch memory.
- On the **local** tier it's memory-bound: each concurrent sandbox loads the
  model, so N concurrent ≈ N× the model's RAM. Keep concurrency low there.
- Issues with unmet blockers are skipped; the unblock cascade re-queues dependents
  as PRs merge, so the pool stays fed without manual relabeling.

## Run

```bash
afk      # autonomous — recommended for throughput
hitl     # reviewed — serializes on your approvals, so less parallel in practice
```
