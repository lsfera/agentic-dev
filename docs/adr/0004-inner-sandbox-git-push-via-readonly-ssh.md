# Inner sandboxes push via a read-only SSH key mount

Inner agentic sandboxes authenticate their git push by reusing the host SSH key, mounted read-only at `$HOME/.ssh` per sandbox — mirroring how the outer devcontainer already mounts it. We chose this over a scoped HTTPS token for parity with agentic.dev's existing SSH-based setup.

The usual objection — private key material spread across disposable, parallel sandboxes — is mitigated by the default-serial concurrency policy (ADR-0003): only one inner sandbox is live at a time, so at most one key copy is in flight.

## Decisions

- Read-only **bind mount** of `~/.ssh`, not ssh-agent forwarding (forwarding across nested Docker is brittle).
- Key lives at `$HOME/.ssh`, outside the repo, so the push-capable agent cannot commit it.

## Consequences

- Parity with the outer container's auth; no new token to provision or rotate.
- Residual accepted risk: an autonomous agent with a mounted key and network egress could exfiltrate it. Blast radius is bounded by serial execution and the key's own repo scope.
- If concurrency is later raised (the ADR-0003 knob), revisit this — multiple live key copies weakens the mitigation.

## Status — deferred in slice 1 (walking skeleton)

The slice-1 orchestrator (`.sandcastle/main.ts`, issue #1) does **not** yet push
from inside the sandbox. The agent only commits to `agent/issue-<N>`; the
**orchestrator** pushes the branch (over the *outer* devcontainer's already-mounted
SSH key) and opens the PR. Rationale: it keeps key material and `gh` out of the
inner image — which is the lean ADR-0002 default (no SSH mount, no `gh`) — and
avoids an unspiked path (SSH-into-inner-sandbox + push) inside the de-risking
skeleton. The end-state this ADR cares about (a branch pushed over the host SSH
key, OAuth-only inside the sandbox) holds; only the *actor* differs.

This ADR's design (push from inside the sandbox) is the target for a later
hardening slice, and becomes load-bearing when concurrency > 1 (ADR-0003 knob):
an orchestrator-serialised single push no longer suffices once sandboxes run in
parallel. Tracked as a follow-up to issue #1.
