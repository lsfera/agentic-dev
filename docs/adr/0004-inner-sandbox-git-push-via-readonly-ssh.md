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
