# The orchestrator is built on Effect 4

Supersedes the plain `async/await` style of the original orchestrator (ADR-0005/0019); behaviour is unchanged.

- **Dependency:** `effect@^4`. `@ai-hero/sandcastle` bundles its own `effect@3` internally; the two coexist because our code only talks to sandcastle through its Promise API (`createSandbox`, `run`, `sandbox.run`) — no Effect values cross that boundary.
- **Typed errors** (`src/errors.ts`): `GhError`, `ShellError`, `SandboxError`, `UnknownError` replace untyped rejections; `cause` keeps the original failure.
- **Adapters return Effects:** `IssueSource` (gh), `SandboxRunner.runIssue`, `ReviewerAdapter.review/runReview`, memory store. The sandbox is an `acquireRelease` resource, so `close()` runs on success, failure *and* interruption.
- **Retry** is `retryEffect` (`src/retry.ts`); `withRetry` remains as a Promise facade.
- **Orchestrator loop** (`main`) is one `Effect.gen` program. Per-issue work and boot-time re-reviews are detached fibers, awaited before a clean exit. `SIGINT`/`SIGTERM` interrupt the root fiber so finalizers run.
- **Webhook HMAC** uses `effect/crypto` (`Mac`, Web Crypto) with constant-time `verify`; `node:crypto` is no longer imported by `main.ts`.
- **Tested seams keep Promise facades** (`resetAgentBranch`, `refreshBase`, `sweepOrphanedSandboxes`, `ensureSandboxNetwork`, `validateSignature`, `classifyDelivery`, `readMemoryContext`, `writeMemoryEntry`) over `*Effect` cores, so tests stay plain `node:test`.
- **Scheduling state** (`inFlight`, attempt counters, dedupe sets) stays as plain in-process structures: the reducer reads `inFlight` by reference and the merge dedupe relies on fibers running synchronously to their first suspension.
