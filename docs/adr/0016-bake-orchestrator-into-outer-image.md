# Bake the orchestrator into the outer image

ADR-0015 publishes the outer devcontainer image, but it only carried the *runtime*
(node, docker, gh, claude + the `afk`/`hitl` launchers). The orchestrator itself —
`.sandcastle/*.ts` and its deps — still had to be **vendored into every adopting
repo**, and `run.sh` ran `npm install` from the bind-mounted workspace on **every**
run. So the "prebuilt outer image" didn't actually deliver the orchestrator.

## Decision

Bake the orchestrator **source** into the published outer image at a non-mounted
path, `/opt/agentic-orchestrator`, and have the launchers prefer the workspace copy
when present.

**Why a non-mounted path.** The workspace bind mounts (`${LOCAL_WORKSPACE_FOLDER}`
and `/workspaces/<proj>`) shadow anything baked under the workspace path at runtime,
so a baked `.sandcastle/node_modules` would be invisible. `/opt/...` is outside the
mounts.

**Why clone, not COPY.** The image is public. COPYing the build context would risk
baking gitignored secrets (`.sandcastle/.env`, `.sandcastle/orchestrator.env`). The
Dockerfile instead **git-fetches the committed code** at `AGENTIC_REF` (the built
commit sha in CI) — secrets are never in a clean checkout. The RUN also deletes any
`.env`/`orchestrator.env`/`logs`/`worktrees` defensively. Gated by `BAKE_ORCHESTRATOR`
so the compose/runtime build (the dogfood) stays lean and untouched.

**Why source only (deps installed on first use).** Node is applied by a devcontainer
*feature*, after the Dockerfile runs, so `npm ci` can't run at Dockerfile time. The
image ships source; `/opt/agentic-orchestrator` is chowned to `vscode`, and `run.sh`
installs deps there on first use — once per container, not per run (the install is
now guarded on a missing/stale lockfile for both the workspace and baked copies).

**Resolution order (run.sh and afk).** Prefer `$workspace/.sandcastle` when it has
`main.ts` (dogfood / vendored adopters → local edits win); else fall back to
`/opt/agentic-orchestrator` (override with `AGENTIC_ORCHESTRATOR_HOME`). `afk` also
locates a project by its `.devcontainer/` so a non-vendoring adopter is found, and
falls back to the baked `run.sh`. The orchestrator always runs with cwd = the
project, so config (`orchestrator.env`/`.env`/`opencode.json`), worktrees, and
project identity resolve against the target repo, never against `/opt`.

## Consequences

- Adopters using the prebuilt image can drop `.sandcastle/*.ts` + `package.json`
  and keep only their **config** in `.sandcastle/` (orchestrator.env, .env,
  opencode.json). They track the orchestrator version via the image tag.
- The dogfood and any vendoring adopter are unchanged — the workspace copy wins.
- `run.sh` no longer reinstalls deps every run (independent win; helps all tiers).
- The baked image is not fully offline on first run (one `npm install` into `/opt`).
  If offline-from-first-boot matters, bake `node_modules` per-arch via a second
  `FROM <devcontainer-image>` build stage (deferred — adds multi-arch build cost).
- `Dockerfile`'s bake clause is build-arg-gated; CI passes `AGENTIC_REF=${github.sha}`
  via `devcontainer.build.json` so the image bakes the exact built commit.
