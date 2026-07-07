# Inject per-language skills via onSandboxReady, not per-language Dockerfiles

ADR-0002/ADR-0024 settled how the inner sandbox gets a language's **toolchain**
(a per-language `.sandcastle/Dockerfile.<lang>`, derived from a lean official
upstream SDK image). Toolchain is not the same problem as **conventions**: a
Dockerfile tells the sandbox how to build and test a dotnet project, but
nothing tells the coding agent *which* patterns a team wants followed —
idiomatic style, testing conventions, house rules a plain "implement this
issue" prompt won't reconstruct on its own. Claude Code's Skills feature
(`SKILL.md` files discovered under `~/.claude/skills`) is the natural
mechanism for capturing that — but nothing today gets project- or
language-specific skills into the **inner** per-issue sandbox where the
coding agent actually runs.

This is a different consumer than ADR-0017, which bakes skills into the
**outer** devcontainer image for the orchestrator's own cockpit-mode Claude
session. That bake is inert for the inner sandbox entirely — a fresh
container per issue, torn down after each run, with no relationship to the
outer image's `~/.claude`.

## Evidence: the hook mechanism already exists and is already used this way

`.sandcastle/sandbox-runner.ts` already copies a file into the worktree and
relocates it inside the sandbox before the agent starts, for exactly this
kind of "the agent needs this file, but it isn't part of the target repo"
need: the local (opencode) tier's `copyToWorktree: ["opencode.json"]` paired
with an `onSandboxReady` step that does
`cp opencode.json "$HOME/.config/opencode/opencode.json"`
(`sandbox-runner.ts:190-201`). Both hooks are generic — sandcastle's own
`RunnerOptions.copyToWorktree`/`hooks.sandbox.onSandboxReady` — not
special-cased to opencode in any way.

Sandcastle's own README documents this same pair as its supported extension
point for "run more setup after the sandbox is ready" (its "Hooks" section —
`hooks.sandbox.onSandboxReady`, paired with `copyToWorktree` for host-relative
files to copy in at creation time). This is the mechanism the package itself
recommends, not a repo-local workaround.

## Alternatives considered and rejected

- **Bake skills into each `Dockerfile.<lang>` via `COPY`.** Rejected: a skill
  edit would require an image rebuild, content would be duplicated across
  every language's Dockerfile instead of living in one place, and it
  conflates "toolchain" (the Dockerfile's job, per ADR-0002) with
  "conventions" (a per-run, swappable concern).
- **Inject via prompt-template substitution alone** (the existing
  `promptFile`/`promptArgs` `{{KEY}}` mechanism). Rejected as the *sole*
  mechanism: it can carry short hints, but it bypasses Claude's actual
  Skills discovery/invocation machinery (the model chooses whether to invoke
  a skill by its name and description; injected prompt text is always-on,
  not conditionally invoked). Useful as a complement, not a substitute.

## Decision

Reuse the existing `copyToWorktree` + `onSandboxReady` hook pair. Add a
generic (not language-aware) `SANDCASTLE_SKILLS_DIR` env var, following the
same pattern as `SANDCASTLE_IMAGE`/`SANDCASTLE_CONTAINER_UID`/`GID`: when
set, `main.ts` passes the directory through to `SandboxRunner`, which
`copyToWorktree`s it into the sandbox and adds an `onSandboxReady` step that
moves its contents into `~/.claude/skills` before the agent starts. The
orchestrator itself stays language-agnostic — it just copies a directory and
runs a `cp -r`; *which* skills that directory holds for a given language
lives outside `.sandcastle/*.ts` entirely (e.g. an
`examples/<lang>-project/skills/` directory alongside that recipe's
`Dockerfile.<lang>` and `orchestrator.env`, matching how `examples/` already
packages per-recipe config today).

## Consequences

- No sandcastle engine change and no new orchestrator language-awareness —
  consistent with ADR-0024's conclusion that per-language needs are a config/
  content problem, not an engine problem.
- Skills become swappable at runtime (edit the directory, next run picks it
  up) without rebuilding the inner image — unlike the Dockerfile-bake
  alternative.
- This ADR is a decision record only; no code changes are made by it.
  Implementing `SANDCASTLE_SKILLS_DIR` in `main.ts`/`sandbox-runner.ts`, and
  writing a first set of per-language skills to prove it out, is separate
  follow-up work, not part of this decision.

## Relations

- ADR-0002 / ADR-0024: establish the Dockerfile as the toolchain extension
  point; this ADR draws the line between toolchain (Dockerfile) and
  conventions (skills injected at runtime).
- ADR-0017: bakes skills into the *outer* image for the orchestrator's own
  Claude session — a different consumer (cockpit mode) than the inner
  per-issue sandbox this ADR addresses.
- ADR-0019: the `copyToWorktree`/`hooks.sandbox.onSandboxReady` lifecycle
  idiom this ADR reuses, already adopted for the local tier's `opencode.json`.
