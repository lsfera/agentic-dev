# Fix the DooD path trap by path-matching the outer mount

ADR-0001's premise failed (sandcastle bind-mounts the worktree; under docker-outside-of-docker the host daemon can't resolve an outer-container path). The fix: make the orchestrator's path string for the project **equal the real host path**, so the worktree under `<project>/.sandcastle/worktrees/<branch>` resolves on the host daemon.

## Validated empirically (Beat 1b, 2026-06-19)

A throwaway outer container with the project bind-mounted at its real host path (`target == source`) ran the spike to green: the inner sandbox mounted the worktree (`SOURCE … /run/host_mark/Users[/…/worktrees/spike-beat-1]`), a hook ran inside it, and the commit landed on `spike/beat-1` visible in the host repo. Two incidental gotchas surfaced and were handled: the inner image is built for **UID 1000** (run the orchestrator as uid 1000, or pass `containerUid`), and a manually-run outer container needs the **docker socket group** fixed (the `docker-outside-of-docker` devcontainer feature already does this in real agentic.dev).

## Decision — non-invasive variant

Do **not** replace `/workspaces/<folder>` (that would churn `devcontainer.json` `workspaceFolder`, `up.sh`, VS Code attach, and docs). Instead **add a parallel bind mount** of the same host dir at its absolute host path, keep `/workspaces/<folder>` for humans/editor, and **run the orchestrator (sandcastle) from the host-path mount** so its worktrees are path-matched. Since `/afk` is `/exec npx tsx .sandcastle/main.ts` (ADR-0006), that exec simply `cd`s to the host-path mount.

## Implemented & validated in the real config (2026-06-19)

Done as a single additive bind mount in `.devcontainer/docker-compose.yml` (target == source == `${LOCAL_WORKSPACE_FOLDER}`), alongside the existing `/workspaces/<basename>` mount. No change to `init.sh` (it already exports `LOCAL_WORKSPACE_FOLDER`), `devcontainer.json`, or `up.sh`. After `./down.sh` + `./up.sh`, Beat 1 ran green **in the real `agentic-sandbox`** (as `vscode`, socket group via the DooD feature, no chmod): worktree resolved to the host path, commit landed on `spike/beat-1`. Still TODO in the orchestrator: make `/afk`'s `/exec` run from `${LOCAL_WORKSPACE_FOLDER}` (ADR-0006) so sandcastle's cwd is the path-matched mount.

## Consequences

- Keeps DooD — no privileged container, no docker-in-docker. The outer devcontainer stays lightweight.
- Preserves the `/workspaces/<folder>` convention for everything except the orchestrator's cwd.
- Requires the project to live under a Docker-Desktop-shared host path (e.g. `/Users`); paths outside the share list must be added in Docker Desktop file sharing.
- Inner image UID must match the orchestrator's runtime UID (vscode=1000 outer, agent=1000 inner — already aligned).
