# /hitl

Human-in-the-loop implementation. Same orchestrator as `/afk`, but the reducer
emits `WaitForHuman` instead of `EnableAutoMerge` — PRs are left open for you
to review and merge. The loop keeps polling until you act (merge or close).

## Prereqs

Same as `/afk` — see that command.

## Run

```
cd "$LOCAL_WORKSPACE_FOLDER" \
  && (cd .sandcastle && npm install) \
  && set -a && . .sandcastle/orchestrator.env && set +a \
  && AGENTIC_MODE=hitl ./.sandcastle/node_modules/.bin/tsx .sandcastle/main.ts
```

## Behavior

- Claims `ready-for-agent` issues and runs sandboxes exactly as in `/afk`.
- After each sandbox, opens a PR and logs `→ PR open, waiting for human review`
  instead of enabling auto-merge.
- Keeps polling while PRs are open so it can detect your action:
  - **Merge the PR** → `PrMerged` unblocks dependents; they enter the ready-set
    on the next tick.
  - **Close the PR without merging** → PR disappears from the open set;
    dependents stay blocked; the orchestrator moves on to other ready work
    or stops if nothing is left.
- Stops cleanly when nothing is ready, nothing is in flight, and no PRs remain
  open.

## Optional env

Same as `/afk`: `AGENTIC_REPO`, `AGENTIC_BASE_BRANCH`, `AGENTIC_MODEL`,
`SANDCASTLE_IMAGE`, `AGENTIC_TIER`, `AGENTIC_LOCAL_MODEL`,
`SANDCASTLE_OPENCODE_IMAGE`.
