# Bake the workflow commands and upstream skills into the outer image

ADR-0016 bakes the orchestrator *source* into the outer image, so an adopter
doesn't vendor `.sandcastle/*.ts`. But the **workflow** the orchestrator drives —
the `/grill-me-with-docs → /to-prd → /to-issues → /afk`/`/hitl` slash commands, and
the engineering disciplines those reference (`/tdd` red-green-refactor, etc.) — still
lived only in this repo's `.claude/commands/`. An adopter who has just the published
image (the goal: ship only the compose file) gets none of them.

## Decision

Bake the workflow into the image and install it into `~/.claude` at container
creation. Split by **who invokes it**, because that maps cleanly onto *what is the
project's own vs. what is upstream*:

- **User-invoked slash commands → vendored.** All seven `.claude/commands/*.md`
  (`afk`, `hitl`, `exec`, `to-prd`, `to-issues`, `tdd`, `grill-me-with-docs`) are
  baked to `/opt/agentic-commands`. They are coupled to the sandcastle flow — the
  `ready-for-agent` label `/afk`/`/hitl` poll on, `/exec`→docker MCP, the
  `docs/grill-output.md → docs/prd.md` handoff chain — so they are the project's own
  and are not interchangeable with upstream.
- **Model-invoked disciplines → upstream.** The four un-forked disciplines the
  workflow leans on (`tdd`, `diagnosing-bugs`, `domain-modeling`, `codebase-design`)
  are pulled from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT,
  © Matt Pocock) to `/opt/agentic-skills`. They live in the separate `~/.claude/skills`
  namespace, so they never collide with the slash commands.

**Why clone at build time, not `npx skills add` at create time.** The upstream
`skills` CLI is interactive, installs *per-project* into the repo working tree, and
needs node — which arrives only *after* the Dockerfile via a devcontainer feature
(same constraint as ADR-0016). A create-time `npx` would prompt, pollute the adopter's
bind-mounted workspace, and can't run in the Dockerfile. Cloning the committed source
at build time (the ADR-0016 pattern) is non-interactive, global, and deterministic per
image. The upstream MIT `LICENSE` is preserved at `/opt/agentic-skills`.

**Why `/opt`, not `~/.claude` directly.** `postCreateCommand` → `claude-persist-setup`
swaps `~/.claude` for a symlink to the persist mount, which would shadow anything baked
under it (the ADR-0016 non-mounted-path reasoning). So the bake lands in `/opt`, and
`claude-persist-setup` copies it into the persisted `~/.claude/{commands,skills}` on
each create — refreshed every time, so a newer image wins.

## Consequences

- An adopter on the prebuilt image gets the full workflow with no vendored
  `.claude/`, tracked via the image tag — the same versioning story as ADR-0016.
- This is **groundwork**: the baked `~/.claude` commands/skills are consumed by a
  `claude` running *inside* the container. The current flow runs Claude on the host
  (it uses the workspace `.claude/commands`), so the bake pays off once that
  host→inside inversion lands. Until then it is inert for the host flow and harmless.
- The dogfood/local build (no `BAKE_ORCHESTRATOR`) is unchanged — it keeps using the
  workspace `.claude/commands`; only the published image carries the bake.
- The upstream disciplines refresh whenever the image is rebuilt (pinnable via
  `MATT_SKILLS_REF`); they are not frozen forks.
