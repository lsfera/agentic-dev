# Sandcastle is not a language constraint — no engine change for multi-language support

agentic-dev's `/afk`/`/hitl` orchestration works well for TypeScript/JS target
projects today. Extending it to other target languages (dotnet, rust) raised
the question of whether the underlying agent-sandbox engine — `@ai-hero/sandcastle`,
the npm package `.sandcastle/main.ts` is built on — should be replaced or
complemented with something that abstracts more naturally across languages,
rather than hand-writing a Dockerfile per language.

## Evidence: sandcastle has no language opinion

`.sandcastle/sandbox-runner.ts` (the sandcastle adapter) calls
`createSandbox({ branch, sandbox: docker({ imageName, ... }), cwd, ... })`
(`sandbox-runner.ts:253`) and `sandbox.run({ agent, maxIterations,
completionSignal, ... })` (`sandbox-runner.ts:286,298`). `.sandcastle/reviewer-adapter.ts`
calls sandcastle's top-level `run({ agent, sandbox: noSandbox(), ... })`
(`reviewer-adapter.ts:222,231`) with `Output.object({ tag: "output", schema })`
for structured extraction (`reviewer-adapter.ts:258,266,274,283`). Every
argument across both call sites is a Docker image name, a git branch/worktree
path, an agent-provider config, or CLI-shaped run options — nothing in
sandcastle's API takes or infers a target-project language.

Sandcastle's own published README (`@ai-hero/sandcastle@0.12.0`, matching this
repo's pinned `.sandcastle/package.json` dependency) describes itself as
"provider-agnostic" (Docker/Podman/Vercel/custom sandboxes) and lists the
scaffolded `Dockerfile` as "Sandbox environment (customize as needed)" in its
project-layout diagram. There is no mention of language, runtime, or toolchain
anywhere in the README — the Dockerfile is explicitly the customization point.

This repo's own `.sandcastle/Dockerfile` already documents the same intent in
its own comment: *"Add a project FROM/derived image if a project needs more
toolchain (ADR-0002)"* (`Dockerfile:7-8`). Only `Dockerfile` (Node) and
`Dockerfile.opencode` exist today — no `Dockerfile.rust`/`.dotnet`/`.python`
variant has ever been added. `docs/adr/0002-lean-inner-image-per-project-extension.md`
already named this exact shape (per-language Dockerfiles) as the intended
extension point; it was simply never executed.

## Alternatives considered and rejected

- **OpenHands** (Python) ships its own opinionated GitHub-issue-resolver and
  Docker-sandboxing loop. Adopting it as the engine would mean throwing away
  this repo's already-built retry semantics (#76), review gate (ADR-0020),
  crash recovery (ADR-0021), and label-driven state machine, and rewriting the
  outer orchestrator in Python to get back roughly what already exists.
- **OpenAgentsControl** (built on opencode, advertises multi-language support)
  is a context-adaptation layer, not a sandbox engine — it doesn't manage
  Docker containers or git worktrees at all, so it doesn't do sandcastle's
  actual job here regardless of its language claims.

## Decision

Keep sandcastle as the sandbox engine. The multi-language gap is not an engine
problem — it's that per-language `.sandcastle/Dockerfile.<lang>` variants,
already anticipated by ADR-0002, were never built. Solve it there, not by
swapping the engine.

## Consequences

- No code changes result from this ADR — it's a decision record, not an
  implementation.
- ADR-0002's guidance on *how* to derive a per-language Dockerfile (`FROM` a
  sibling `devcontainer-*` image in this workspace) is separately stale and
  corrected by a dated addendum on that ADR (see its 2026-07-06 addendum).
- Building actual per-language Dockerfile variants (dotnet, rust, etc.)
  remains unbuilt and is tracked as separate follow-up work, not part of this
  decision.

## Relations

- ADR-0002: names the per-language Dockerfile extension point this ADR
  confirms is the right layer for multi-language support; its derivation
  guidance is corrected by a same-day addendum.
- ADR-0019: the `createSandbox`/`sandbox.run()` lifecycle cited as evidence
  here is the same high-level API adopted in that ADR.
