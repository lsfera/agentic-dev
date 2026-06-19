# Agentic sandboxes exchange code via git, not bind mounts

The orchestrator (sandcastle) runs inside the outer devcontainer, which reaches Docker through docker-outside-of-docker (the host socket is bind-mounted in). Bind-mounting a host worktree into an inner agentic sandbox would be resolved by the *host* daemon, which has no `/workspaces/...` path — the classic DooD path trap — and would also serialize parallel per-issue agents fighting over one mount.

We therefore use sandcastle's `branch` (isolated) strategy: each agentic sandbox gets its own checkout and commits to a named branch pushed back to the remote. This matches agentic.dev's existing philosophy that the container is disposable and durable state lives in git/issues, not local files.

## CONFIRMED FALSE — Beat 1, empirically (2026-06-19)

The premise is refuted by a real run, not just the Dockerfile comment. Beat 1 inside the outer devcontainer failed hard:

```
WorktreeError: Provider 'docker' create failed: docker run failed:
  mounts denied: The path /workspaces/skeleton-spike/.sandcastle/worktrees/spike-beat-1
  is not shared from the host and is not known to Docker.
```

So: (1) the `docker()` provider bind-mounts the worktree even in `branch`/isolated mode; (2) under docker-outside-of-docker the host daemon rejects the mount because the source is an outer-container path — the DooD path trap is real and **hard-fails** (no silent corruption). git-isolation survives as the *code-movement* model, but it does **not** sidestep the bind mount, so the outer devcontainer's docker topology must change. See **ADR-0011**.

Useful detail for the fix: the worktree lands at `<project>/.sandcastle/worktrees/<branch>` — *under the project dir*, not a temp path. So path-matching the project mount is sufficient to make the worktree resolve on the host daemon (the worktree inherits the matched path). **Beat 1b proved this works** — see ADR-0011. git-isolation stands as the code-movement model; the topology fix is path-matching, not DinD.

## Consequences (revised)

- Parallel agentic sandboxes remain safe — each gets its own branch/checkout.
- Agents cannot act on uncommitted working-tree state; everything flows through commits and branches. Accepted.
- The "no bind mount, keep lightweight DooD" consequence is **withdrawn** — superseded by ADR-0011.
