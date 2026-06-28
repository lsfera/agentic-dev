# Lean execution layer — high-level sandcastle lifecycle

The original `sandbox-runner.ts` called `run()` directly and hand-rolled its
own lifecycle: building the full options object inline, embedding prompt text
in TypeScript string arrays, and relying on `run()`'s internal teardown. This
was functional but kept bespoke lifecycle logic in the adapter rather than
delegating it to the library.

`@ai-hero/sandcastle@0.10.0` ships a higher-level API — `createSandbox` +
`await using` + `hooks.onSandboxReady` + `promptFile`/`promptArgs` — that owns
worktree creation, scope-bound disposal, declarative in-sandbox setup, and
prompt template substitution. Adopting it shrinks the adapter to its essential
role: translating `RunnerOptions` + `IssueInput` to a plain config object, then
handing off to the library.

## Decision

`SandboxRunner.runIssue` uses the high-level lifecycle:

```typescript
await using sandbox = await createSandbox({
  branch,
  sandbox: docker({ imageName, containerUid, containerGid, network }),
  cwd,
  copyToWorktree,
  hooks: { sandbox: { onSandboxReady: [...] } },
});

const result = await sandbox.run({
  agent,
  name,
  maxIterations,
  completionSignal,
  promptFile,
  promptArgs,
});
```

**`await using` replaces bespoke teardown.** `createSandbox` returns a `Sandbox`
handle that implements `Symbol.asyncDispose`; the scope-bound disposal calls
`sandbox.close()` when the block exits, normally or via exception. The library
owns worktree cleanup — the adapter no longer needs a `finally` block.

**`hooks.onSandboxReady` replaces prompt-embedded setup.** The local tier's
`opencode.json` relocation command was previously embedded in prompt text (making
it part of the agent's instructions, not the sandbox lifecycle). It now lives in
`hooks.sandbox.onSandboxReady`, where sandcastle runs it once after boot and
before the agent starts. The agent prompt no longer describes bootstrapping.

**`promptFile` + `promptArgs` replace inline string builders.** Agent prompts
move to `.md` templates (`prompt-claude.md`, `prompt-local.md`) alongside the
runner source. `{{KEY}}` placeholders are resolved by sandcastle at run time from
`promptArgs`; only the template selection (one file per tier) stays conditional in
`buildAgentInput`. The `buildPrompt`/`buildLocalPrompt` string-builder functions
are removed.

**`buildAgentInput` is the pure builder seam.** The function is extended to take
both `RunnerOptions` and `IssueInput` and returns the complete config for both
`createSandbox()` and `sandbox.run()` (agent, imageName, network, copyToWorktree,
onSandboxReady, promptFile, promptArgs). It remains pure and exported so
`sandbox-runner.test.ts` can assert on all config fields without spawning Docker.

## Two asymmetries that stay imperative

### MTU network — declarative attachment, imperative creation

`docker({ network: SANDBOX_NETWORK })` attaches the inner container to the
MTU-1400 network declaratively (ADR-0013). `ensureSandboxNetwork` (in `main.ts`)
creates it imperatively with `--opt com.docker.network.driver.mtu=1400` before
the first sandbox starts. This split is intentional: `docker()` has no option
to create a custom-MTU network, only to attach to an existing one. Do not move
network creation into `docker()`.

### Socat proxy — imperative host override

`resolveDockerHost` sets `process.env.DOCKER_HOST` to the direct socket path
(`unix:///var/run/docker-host.sock`) when the DooD socat proxy is detected (#71).
This bypasses socat because socat tears down `docker exec`'s hijacked bidirectional
stream after the first burst, causing every sandbox iteration to be an empty
"started → stopped" turn with zero commits. `docker()` has no `host` or `socket`
option, so this cannot be expressed declaratively. `resolveDockerHost` and its
`process.env` mutation in `main.ts` are unchanged. Do not "tidy" this into the
docker options — the bug returns immediately.

## Consequences

- `SandboxRunner` is thinner: worktree creation, teardown, in-sandbox setup, and
  prompt rendering are all delegated to the library.
- `/afk` and `/hitl` behavior is unchanged — they still get one PR per ready
  issue with auto-merge on green CI.
- The pure builder seam (`buildAgentInput`) remains testable without Docker; the
  test suite covers image selection, network forwarding, copyToWorktree, hook
  commands, template paths, and promptArgs in isolation.
- The live `createSandbox`/`await using` round-trip is covered by the existing
  gated `integration.test.ts` (`SANDCASTLE_INTEGRATION=1`); the CI `sandcastle`
  job is unaffected.

## Relations

- ADR-0006: `/afk` still wraps sandcastle via exec — `createSandbox` execs under
  the hood just as `run()` did.
- ADR-0013: MTU network creation stays in `ensureSandboxNetwork`; `docker(network)`
  only attaches. The split is recorded here.
- #71 (socat fix): `resolveDockerHost` stays imperative. See the asymmetry note
  above.
