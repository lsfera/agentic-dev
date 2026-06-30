# Durable agent lifecycle labels

Two GitHub labels — `agent:in-progress` and `agent:in-review` — mark the two work-item lifecycle phases that otherwise leave no durable artifact on GitHub: a sandbox actively implementing an issue, and the AI reviewer (ADR-0020) running on an open PR. They make the orchestrator's in-flight state **durable for crash recovery**: `State.inFlight` stays the runtime source of truth, and the labels are a mirror written at each transition and read only at startup to reconcile work a crashed predecessor left mid-flight.

## Why

The work-item lifecycle has four phases, but only the endpoints carry a GitHub artifact:

| Phase | Durable artifact before this change |
| --- | --- |
| unblocked, workable | `ready-for-agent` label |
| **sandbox implementing** | none — `State.inFlight` (in-memory) only |
| **reviewer running on the open PR** | the PR exists, but nothing marks that a review is in flight |
| done | closed issue |

If the orchestrator is killed mid-flight, the in-memory `inFlight` is lost and the issue — claimed (i.e. `ready-for-agent` removed) but unlabelled — is silently abandoned. `#76` re-queues on a `SandboxFailed` *event*, but process death is not an event, so the crash gap is real and otherwise uncovered.

## Lifecycle

- **Claim:** `ready-for-agent` → `agent:in-progress`.
- **PR opened (SandboxFinished):** `agent:in-progress` → `agent:in-review`.
- **Verdict (ReviewFinished):** `agent:in-review` → removed. From here the PR + CI status are the artifact; `pass` → EnableAutoMerge, `changes-requested`/fail-safe → WaitForHuman (review posted).
- **SandboxFailed (#76):** `agent:in-progress` → `ready-for-agent` (retry) or unlabelled + comment (retries exhausted).

## Startup reconcile (the point of the durability)

- `agent:in-progress` found (no PR yet) → **re-queue** to `ready-for-agent`; the normal tick re-claims and starts fresh. `resetAgentBranch` (#23) already wipes the stale `agent/issue-N` branch.
- `agent:in-review` found (PR already open) → **re-run the read-only review** on the existing PR; do **not** re-queue (that would spawn a duplicate sandbox and a second PR) and do not leave it stuck (the pending-PR reconcile loop does not re-review). The reviewer is read-only and runs off the PR diff, so re-reviewing is idempotent.

## Considered and rejected

- **Labels as the hot-path source of truth** — rejected. GitHub-API latency on every tick is not worth it; `State.inFlight` stays authoritative at runtime and the labels are a durable mirror, read only at boot.
- **One label (in-progress only)** — rejected: it misses the reviewer window, which has no artifact until the review posts. **Full pipeline as labels** (`agent:ready`/`…in-progress`/`…in-review`/`…merging`) — also rejected: the open PR + CI already are the artifact for the post-review phases, so extra labels just duplicate state to keep consistent. Two labels fill exactly the two artifact-less phases.
- **A hard cross-process lock** — rejected as a non-goal. Preventing double-claim is a *defensive guardrail* only (a running orchestrator skips `agent:in-progress`/`agent:in-review` issues); there is no concurrent-orchestrator scenario today, and GitHub labels have no atomic compare-and-swap (two writers both see `ready-for-agent` and both claim — unsolvable with labels). Single-writer-per-project holds; **do not** build atomic locking on top of labels.
- **Renaming `ready-for-agent` → `agent:ready`** for namespace consistency — rejected: it is the `READY_LABEL` constant referenced across `reduce.ts`, `CLAUDE.md`, `to-issues`, and existing open issues; a breaking rename + migration is not worth prefix symmetry. Keep `ready-for-agent`; add the `agent:*` pair alongside it.

## Notes

- The label transitions belong in the pure reducer (`reduce.ts`, emitting `Relabel`/`SetLabel` actions) so they are unit-testable, consistent with the repo's reducer-is-the-seam philosophy. The orchestrator carries them out.
- Relates to ADR-0020 (the review gate whose window `agent:in-review` marks) and #76 (the `SandboxFailed` retry that is `agent:in-progress`'s failure exit).
