# Outer devcontainer authenticates git via the host's ssh-agent, not a ~/.ssh mount

The outer devcontainer used to bind-mount the host's `~/.ssh` read-only. That put
the raw private key inside the container and dragged in the host's `ssh/config` —
which on macOS typically carries `UseKeychain yes`, a macOS-only option that Linux
OpenSSH rejects (`Bad configuration option: usekeychain`), breaking every `ssh` /
`git push` in the container. We now forward the host's **ssh-agent socket** instead,
so keys stay in the host keychain/agent and only signing requests cross the boundary.

## Decisions

- Mount `${SSH_AUTH_SOCK_HOST:-/run/host-services/ssh-auth.sock}` at `/ssh-agent.sock`
  and set `SSH_AUTH_SOCK=/ssh-agent.sock`. Docker Desktop exposes the host agent at that
  in-VM path; on macOS that is the launchd agent fed by the Keychain.
- Native Docker Engine on Linux: `init.sh` writes the host's `$SSH_AUTH_SOCK` into
  `SSH_AUTH_SOCK_HOST`; a bare `docker compose up` there must export it manually.
- `~/.ssh` is no longer mounted. GitHub's published host keys are shipped as an inline
  Compose `config` at `/etc/ssh/ssh_known_hosts` (Compose ≥ 2.23), so the file stays
  self-contained for compose-only adopters and needs no image rebuild.
- The container's `command` makes the root-owned socket usable by `vscode`, alongside
  the existing docker-host.sock fixup.

## Consequences

- The host agent must hold the key. On macOS after a reboot: `ssh-add --apple-load-keychain`
  (or rely on `AddKeysToAgent yes` + `UseKeychain yes` loading it on first host-side use).
  Check from inside the container with `ssh-add -l`.
- Hosts other than github.com are not pre-trusted; the first connection prompts (and
  `~/.ssh/known_hosts` in the container is ephemeral).
- Supersedes the "mirroring how the outer devcontainer already mounts it" premise of
  ADR-0004. Inner sandboxes are unaffected — they still get no SSH material; the
  orchestrator pushes from the outer container (ADR-0004 status).
