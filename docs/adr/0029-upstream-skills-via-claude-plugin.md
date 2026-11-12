# Install upstream skills as a Claude Code plugin, not a build-time clone

**Status:** Accepted. Supersedes the "upstream skills" half of ADR-0017 (the vendored
slash-command bake is unchanged).

ADR-0017 cloned `mattpocock/skills` in the Dockerfile, hand-picked four skills into
`/opt/agentic-skills`, and had `claude-persist-setup` copy them into `~/.claude/skills`.
It rejected `npx skills add` (interactive, per-project, needs node). Claude Code now has a
first-class answer: the same repo is published as the plugin
`skills-for-real-engineers@anthropic-plugin-directory`, installable non-interactively and
globally with `claude plugin install <id> --scope user --yes`.

## Decision

- Drop the skills clone, `MATT_SKILLS_REF`/`MATT_SKILLS_REPO_URL`, and `/opt/agentic-skills`
  from the Dockerfile.
- `claude-persist-setup` runs the plugin install at container creation (user scope, so state
  lands in the persisted `~/.claude`). Override the id with `AGENTIC_SKILLS_PLUGIN`; set it
  empty to skip (`AGENTIC_SKILLS_PLUGIN=`).
- Workflow slash commands (`/afk`, `/hitl`, `/exec`, `/to-prd`, `/to-issues`, `/tdd`,
  `/grill-me-with-docs`) stay vendored at `/opt/agentic-commands` — they are coupled to the
  sandcastle flow.

## Consequences

- No hand-maintained skill list, ref pinning (the marketplace pins a sha) or LICENSE copy;
  updates via `claude plugin update`.
- Plugin skills are namespaced by the plugin's manifest name (`mattpocock-skills:tdd`, even
  though the marketplace id is `skills-for-real-engineers`).
- The plugin ships 25 skills, not the four previously baked (~1.1k tokens always-on). Some
  (`to-spec`, `to-tickets`, `grill-with-docs`, `grill-me`) overlap in purpose with our
  `/to-prd`, `/to-issues` and `/grill-me-with-docs`. They don't replace them: the commands
  stay the sandcastle-coupled entry points, and the workflow never depends on the upstream
  equivalents.
- The install is best-effort and needs network at create time; offline, it warns and the
  skills are simply unavailable (the image is no longer deterministic for skills).
- Inner per-issue sandboxes are unaffected (ADR-0025).
