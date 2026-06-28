/**
 * Unit tests for the pure reducer — the primary test seam. No Docker, GitHub,
 * or network: construct a world-state, send an event, assert the emitted
 * actions. Tests assert external behavior (the action set), never internal
 * structure or adapter call order.
 *
 * Run (fast): npm test   →  node --import tsx --test reduce.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, READY_LABEL, type State, type CiStatus, type Pr } from "./reduce.ts";
import { parseBlockedBy } from "./issue-source.ts";
import { sweepOrphanedSandboxes, ensureSandboxNetwork, parseConcurrency, withRetry, resetAgentBranch, refreshBase, validateSignature, classifyDelivery, parseSmeeEvent, parseOrchEnv, resolveCredentials } from "./main.ts";
import { createHmac } from "node:crypto";
import { SANDBOX_LABEL, PROJECT_LABEL_KEY, deriveProject } from "./sandbox-runner.ts";

const base = (over: Partial<State> = {}): State => ({
  issues: [],
  prs: [],
  inFlight: [],
  policy: { concurrency: 1, mode: "afk" },
  ...over,
});

test("ready issue under serial policy -> exactly one StartSandbox", () => {
  const state = base({
    issues: [{ id: 1, labels: [READY_LABEL], blockedBy: [] }],
  });
  assert.deepEqual(reduce(state, { type: "Tick" }), [
    { type: "StartSandbox", issueId: 1 },
  ]);
});

test("two ready issues under serial policy -> still only one (lowest id)", () => {
  const state = base({
    issues: [
      { id: 2, labels: [READY_LABEL], blockedBy: [] },
      { id: 1, labels: [READY_LABEL], blockedBy: [] },
    ],
  });
  assert.deepEqual(reduce(state, { type: "Tick" }), [
    { type: "StartSandbox", issueId: 1 },
  ]);
});

test("nothing ready and nothing in flight -> Stop", () => {
  assert.deepEqual(reduce(base(), { type: "Tick" }), [{ type: "Stop" }]);
});

test("issue without the ready label is ignored -> Stop", () => {
  const state = base({ issues: [{ id: 1, labels: [], blockedBy: [] }] });
  assert.deepEqual(reduce(state, { type: "Tick" }), [{ type: "Stop" }]);
});

test("issue already in flight is not restarted, and we do not Stop", () => {
  const state = base({
    issues: [{ id: 1, labels: [READY_LABEL], blockedBy: [] }],
    inFlight: [1],
  });
  assert.deepEqual(reduce(state, { type: "Tick" }), []);
});

test("issue with an existing PR is not restarted, and loop stays alive for auto-merge", () => {
  const state = base({
    issues: [{ id: 1, labels: [READY_LABEL], blockedBy: [] }],
    prs: [{ issue: 1, ciStatus: "pending", merged: false }],
  });
  // Open PR keeps the afk loop alive (awaiting auto-merge); no StartSandbox emitted.
  const actions = reduce(state, { type: "Tick" });
  assert.ok(!actions.some((a) => a.type === "Stop"), "open PR keeps loop alive");
  assert.ok(!actions.some((a) => a.type === "StartSandbox"), "issue already has a PR");
});

// ─── parseBlockedBy ──────────────────────────────────────────────────────────

test("parseBlockedBy: empty body returns []", () => {
  assert.deepEqual(parseBlockedBy(""), []);
});

test("parseBlockedBy: no blocked-by section returns []", () => {
  assert.deepEqual(parseBlockedBy("This is a regular issue body."), []);
});

test("parseBlockedBy: single inline reference", () => {
  assert.deepEqual(parseBlockedBy("Blocked by #1"), [1]);
});

test("parseBlockedBy: multiple inline references", () => {
  assert.deepEqual(parseBlockedBy("Blocked by #1, #2"), [1, 2]);
});

test("parseBlockedBy: GitHub markdown section format", () => {
  assert.deepEqual(
    parseBlockedBy("## Blocked by\n\n- #1\n- #2\n"),
    [1, 2],
  );
});

test("parseBlockedBy: stops at next markdown section", () => {
  assert.deepEqual(
    parseBlockedBy("## Blocked by\n\n- #1\n\n## Other section\n\n- #99\n"),
    [1],
  );
});

// ─── Dependency blocking (isReady + Tick) ────────────────────────────────────

test("issue with no blockers (blockedBy: []) behaves as before", () => {
  const state = base({
    issues: [{ id: 1, labels: [READY_LABEL], blockedBy: [] }],
  });
  assert.deepEqual(reduce(state, { type: "Tick" }), [
    { type: "StartSandbox", issueId: 1 },
  ]);
});

test("issue blocked by unmerged PR is not started, loop stays alive for auto-merge", () => {
  const state = base({
    issues: [{ id: 2, labels: [READY_LABEL], blockedBy: [1] }],
    prs: [{ issue: 1, ciStatus: "pending" as CiStatus, merged: false }],
  });
  // Issue 2 can't start yet, but blocker 1's open PR keeps the afk loop alive.
  const actions = reduce(state, { type: "Tick" });
  assert.ok(!actions.some((a) => a.type === "Stop"), "open PR keeps loop alive");
  assert.ok(!actions.some((a) => a.type === "StartSandbox"), "issue 2 is still blocked");
});

test("issue blocked by absent PR (blocker not yet done) is not started", () => {
  const state = base({
    issues: [{ id: 2, labels: [READY_LABEL], blockedBy: [1] }],
    prs: [],
  });
  assert.deepEqual(reduce(state, { type: "Tick" }), [{ type: "Stop" }]);
});

test("issue with all blockers merged is started", () => {
  const state = base({
    issues: [{ id: 2, labels: [READY_LABEL], blockedBy: [1] }],
    prs: [{ issue: 1, ciStatus: "success" as CiStatus, merged: true }],
  });
  assert.deepEqual(reduce(state, { type: "Tick" }), [
    { type: "StartSandbox", issueId: 2 },
  ]);
});

test("partially merged blockers keep issue blocked, loop stays alive for remaining auto-merge", () => {
  const state = base({
    issues: [{ id: 3, labels: [READY_LABEL], blockedBy: [1, 2] }],
    prs: [
      { issue: 1, ciStatus: "success" as CiStatus, merged: true },
      { issue: 2, ciStatus: "pending" as CiStatus, merged: false },
    ],
  });
  // Issue 3 is still blocked (blocker 2 not merged), but open PR keeps loop alive.
  const actions = reduce(state, { type: "Tick" });
  assert.ok(!actions.some((a) => a.type === "Stop"), "open PR keeps loop alive");
  assert.ok(!actions.some((a) => a.type === "StartSandbox"), "issue 3 is still blocked");
});

// ─── PrMerged event ──────────────────────────────────────────────────────────

test("PrMerged unblocks a dependent issue when all its blockers are now merged", () => {
  const mergedPr = { issue: 1, ciStatus: "success" as CiStatus, merged: true };
  const state = base({
    issues: [{ id: 2, labels: [], blockedBy: [1] }],
    prs: [],
  });
  assert.deepEqual(reduce(state, { type: "PrMerged", pr: mergedPr }), [
    { type: "Relabel", issueId: 2, label: READY_LABEL },
  ]);
});

test("PrMerged does not unblock when a different blocker is still unmerged", () => {
  const mergedPr = { issue: 1, ciStatus: "success" as CiStatus, merged: true };
  const state = base({
    issues: [{ id: 3, labels: [], blockedBy: [1, 2] }],
    prs: [{ issue: 2, ciStatus: "pending" as CiStatus, merged: false }],
  });
  assert.deepEqual(reduce(state, { type: "PrMerged", pr: mergedPr }), []);
});

test("PrMerged unblocks only issues whose blocker is the merged PR", () => {
  const mergedPr = { issue: 1, ciStatus: "success" as CiStatus, merged: true };
  const state = base({
    issues: [
      { id: 2, labels: [], blockedBy: [1] }, // blocked by 1 → unblocked
      { id: 3, labels: [], blockedBy: [4] }, // blocked by 4 → still blocked
    ],
    prs: [],
  });
  assert.deepEqual(reduce(state, { type: "PrMerged", pr: mergedPr }), [
    { type: "Relabel", issueId: 2, label: READY_LABEL },
  ]);
});

test("PrMerged unblocks all fully-resolved dependents in one call", () => {
  const mergedPr = { issue: 1, ciStatus: "success" as CiStatus, merged: true };
  const state = base({
    issues: [
      { id: 2, labels: [], blockedBy: [1] },
      { id: 3, labels: [], blockedBy: [1] },
    ],
    prs: [],
  });
  const actions = reduce(state, { type: "PrMerged", pr: mergedPr });
  assert.deepEqual(actions.length, 2);
  assert.ok(actions.some((a) => a.type === "Relabel" && a.type === "Relabel" && (a as { issueId: number }).issueId === 2));
  assert.ok(actions.some((a) => a.type === "Relabel" && (a as { issueId: number }).issueId === 3));
});

// ─── SandboxFinished / EnableAutoMerge / WaitForHuman ───────────────────────

test("afk mode + SandboxFinished → EnableAutoMerge", () => {
  const pr: Pr = { issue: 1, ciStatus: "pending", merged: false };
  const state = base({ policy: { concurrency: 1, mode: "afk" } });
  assert.deepEqual(reduce(state, { type: "SandboxFinished", issue: 1, pr }), [
    { type: "EnableAutoMerge", pr },
  ]);
});

test("hitl mode + SandboxFinished → WaitForHuman", () => {
  const pr: Pr = { issue: 1, ciStatus: "pending", merged: false };
  const state = base({ policy: { concurrency: 1, mode: "hitl" } });
  assert.deepEqual(reduce(state, { type: "SandboxFinished", issue: 1, pr }), [
    { type: "WaitForHuman", pr },
  ]);
});

test("afk mode + Tick with open PR and nothing else ready → no Stop (waiting for CI)", () => {
  const state = base({
    issues: [{ id: 1, labels: [], blockedBy: [] }],
    prs: [{ issue: 1, ciStatus: "pending", merged: false }],
    policy: { concurrency: 1, mode: "afk" },
  });
  const actions = reduce(state, { type: "Tick" });
  assert.ok(!actions.some((a) => a.type === "Stop"), "should not Stop while PR is pending auto-merge");
});

test("Tick with pending CI on open PR does not emit EnableAutoMerge", () => {
  const state = base({
    issues: [{ id: 1, labels: [], blockedBy: [] }],
    prs: [{ issue: 1, ciStatus: "pending", merged: false }],
    policy: { concurrency: 1, mode: "afk" },
  });
  const actions = reduce(state, { type: "Tick" });
  assert.ok(!actions.some((a) => a.type === "EnableAutoMerge"), "Tick should not emit EnableAutoMerge");
});

test("hitl mode + Tick with open PR and nothing else ready → no Stop (waiting for human)", () => {
  const state = base({
    issues: [{ id: 1, labels: [], blockedBy: [] }],
    prs: [{ issue: 1, ciStatus: "pending", merged: false }],
    policy: { concurrency: 1, mode: "hitl" },
  });
  const actions = reduce(state, { type: "Tick" });
  assert.ok(!actions.some((a) => a.type === "Stop"), "should not Stop while PR awaits human review");
});

test("hitl mode + closed-unmerged PR (PR gone from state) → Stop; dependents remain blocked", () => {
  // Simulate state after issue 1's PR was closed without merging:
  // - Issue 1 is claimed (ready label removed), PR no longer in allPrs
  // - Issue 2 is blocked by 1 and has no ready-for-agent label (PrMerged never fired)
  const state = base({
    issues: [
      { id: 1, labels: [], blockedBy: [] },
      { id: 2, labels: [], blockedBy: [1] },
    ],
    prs: [],
    policy: { concurrency: 1, mode: "hitl" },
  });
  assert.deepEqual(reduce(state, { type: "Tick" }), [{ type: "Stop" }]);
});

// ─── Concurrency knob ────────────────────────────────────────────────────────

test("concurrency=2 with 2 ready issues -> emits 2 StartSandbox (lowest IDs first)", () => {
  const state = base({
    issues: [
      { id: 3, labels: [READY_LABEL], blockedBy: [] },
      { id: 1, labels: [READY_LABEL], blockedBy: [] },
      { id: 2, labels: [READY_LABEL], blockedBy: [] },
    ],
    policy: { concurrency: 2, mode: "afk" },
  });
  assert.deepEqual(reduce(state, { type: "Tick" }), [
    { type: "StartSandbox", issueId: 1 },
    { type: "StartSandbox", issueId: 2 },
  ]);
});

test("concurrency=N with N ready issues -> emits N StartSandbox", () => {
  const n = 3;
  const state = base({
    issues: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      labels: [READY_LABEL],
      blockedBy: [],
    })),
    policy: { concurrency: n, mode: "afk" },
  });
  const actions = reduce(state, { type: "Tick" });
  assert.equal(actions.filter((a) => a.type === "StartSandbox").length, n);
});

test("concurrency=2 with 1 in-flight -> only 1 more StartSandbox emitted", () => {
  const state = base({
    issues: [
      { id: 1, labels: [READY_LABEL], blockedBy: [] },
      { id: 2, labels: [READY_LABEL], blockedBy: [] },
      { id: 3, labels: [READY_LABEL], blockedBy: [] },
    ],
    inFlight: [10],
    policy: { concurrency: 2, mode: "afk" },
  });
  const actions = reduce(state, { type: "Tick" });
  const starts = actions.filter((a) => a.type === "StartSandbox");
  assert.equal(starts.length, 1, "only 1 slot remains (2 - 1 in-flight)");
  assert.deepEqual(starts[0], { type: "StartSandbox", issueId: 1 });
});

test("in-flight count fully saturates cap -> no StartSandbox emitted", () => {
  const state = base({
    issues: [
      { id: 3, labels: [READY_LABEL], blockedBy: [] },
      { id: 4, labels: [READY_LABEL], blockedBy: [] },
    ],
    inFlight: [1, 2],
    policy: { concurrency: 2, mode: "afk" },
  });
  const actions = reduce(state, { type: "Tick" });
  assert.ok(!actions.some((a) => a.type === "StartSandbox"), "no slots — cap fully used");
});

test("default concurrency is 1: two ready issues -> exactly one StartSandbox", () => {
  const state = base({
    issues: [
      { id: 1, labels: [READY_LABEL], blockedBy: [] },
      { id: 2, labels: [READY_LABEL], blockedBy: [] },
    ],
  });
  assert.equal(state.policy.concurrency, 1);
  assert.deepEqual(reduce(state, { type: "Tick" }), [
    { type: "StartSandbox", issueId: 1 },
  ]);
});

// ─── Demo: two-issue chain A blocks B ────────────────────────────────────────

// ─── Orphan sweep ────────────────────────────────────────────────────────────

test("SANDBOX_LABEL has the agentic.sandbox key", () => {
  assert.ok(SANDBOX_LABEL.startsWith("agentic.sandbox="), `expected 'agentic.sandbox=…', got '${SANDBOX_LABEL}'`);
});

test("sweepOrphanedSandboxes: no containers → returns 0 and skips docker rm", async () => {
  const calls: Array<[string, string[]]> = [];
  const exec = (file: string, args: string[]) => {
    calls.push([file, args]);
    return Promise.resolve({ stdout: "" });
  };
  const count = await sweepOrphanedSandboxes(exec);
  assert.equal(count, 0);
  assert.ok(!calls.some(([, a]) => a[0] === "rm"), "docker rm must not be called when no containers found");
});

test("sweepOrphanedSandboxes: found containers → calls docker rm -f and returns count", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec = (file: string, args: string[]) => {
    calls.push({ file, args });
    return Promise.resolve({ stdout: args[0] === "ps" ? "abc123\ndef456\n" : "" });
  };
  const count = await sweepOrphanedSandboxes(exec);
  assert.equal(count, 2);
  const rm = calls.find((c) => c.args[0] === "rm");
  assert.ok(rm, "docker rm should be called");
  assert.ok(rm!.args.includes("-f"), "rm must be forced");
  assert.ok(rm!.args.includes("abc123") && rm!.args.includes("def456"), "rm must include all container ids");
});

test("sweepOrphanedSandboxes: docker error → returns 0 without throwing", async () => {
  const exec = () => Promise.reject(new Error("Docker unavailable"));
  const count = await sweepOrphanedSandboxes(exec as Parameters<typeof sweepOrphanedSandboxes>[0]);
  assert.equal(count, 0);
});

test("sweepOrphanedSandboxes: docker ps uses SANDBOX_LABEL as the filter", async () => {
  let psArgs: string[] = [];
  const exec = (file: string, args: string[]) => {
    if (args[0] === "ps") psArgs = args;
    return Promise.resolve({ stdout: "" });
  };
  await sweepOrphanedSandboxes(exec);
  assert.ok(
    psArgs.includes(`label=${SANDBOX_LABEL}`),
    `docker ps must filter by 'label=${SANDBOX_LABEL}'`,
  );
});

// ─── Project-scoped sweep (#40) ──────────────────────────────────────────────

test("PROJECT_LABEL_KEY is the agentic.sandbox.project label key", () => {
  assert.equal(PROJECT_LABEL_KEY, "agentic.sandbox.project");
});

test("deriveProject: 'owner/name' → name; bare name → name; falls back to cwd basename", () => {
  assert.equal(deriveProject("lsfera/agentic.dev", "/x/y"), "agentic.dev");
  assert.equal(deriveProject("agentic.dev", "/x/y"), "agentic.dev");
  assert.equal(deriveProject(undefined, "/Users/lsfera/dvcs/agentic.dev"), "agentic.dev");
  assert.equal(deriveProject("", "/Users/lsfera/dvcs/myproj/"), "myproj");
});

test("sweepOrphanedSandboxes: project requests the project label in the ps format", async () => {
  let psArgs: string[] = [];
  const exec = (file: string, args: string[]) => {
    if (args[0] === "ps") psArgs = args;
    return Promise.resolve({ stdout: "" });
  };
  await sweepOrphanedSandboxes(exec, "agentic.dev");
  assert.ok(psArgs.includes(`label=${SANDBOX_LABEL}`), "still filters by base label");
  assert.ok(
    psArgs.some((a) => a.includes(PROJECT_LABEL_KEY)),
    `ps format must read the '${PROJECT_LABEL_KEY}' label`,
  );
});

test("sweepOrphanedSandboxes: scoped to project — sweeps own + unowned, skips other project", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec = (file: string, args: string[]) => {
    calls.push({ file, args });
    // own-project, legacy/unowned (empty label), and another project
    const out = "own111\tagentic.dev\nlegacy222\t\nother333\tother-proj\n";
    return Promise.resolve({ stdout: args[0] === "ps" ? out : "" });
  };
  const count = await sweepOrphanedSandboxes(exec, "agentic.dev");
  assert.equal(count, 2, "own-project + unowned containers are swept");
  const rm = calls.find((c) => c.args[0] === "rm")!;
  assert.ok(rm.args.includes("own111"), "own-project container swept");
  assert.ok(rm.args.includes("legacy222"), "unowned (legacy) container swept");
  assert.ok(!rm.args.includes("other333"), "other project's container must NOT be swept");
});

test("sweepOrphanedSandboxes: no project arg → sweeps every agentic sandbox (legacy behaviour)", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec = (file: string, args: string[]) => {
    calls.push({ file, args });
    const out = "a\tagentic.dev\nb\tother-proj\nc\t\n";
    return Promise.resolve({ stdout: args[0] === "ps" ? out : "" });
  };
  const count = await sweepOrphanedSandboxes(exec);
  assert.equal(count, 3, "unscoped sweep removes all agentic sandboxes regardless of project");
  const rm = calls.find((c) => c.args[0] === "rm")!;
  assert.ok(["a", "b", "c"].every((id) => rm.args.includes(id)));
});

// ─── Sandbox network / MTU (#48) ─────────────────────────────────────────────

test("ensureSandboxNetwork: existing network → inspect only, no create", async () => {
  const calls: Array<string[]> = [];
  const exec = (_file: string, args: string[]) => {
    calls.push(args);
    return Promise.resolve({ stdout: "[]" }); // inspect succeeds
  };
  const ok = await ensureSandboxNetwork("net", "1400", exec);
  assert.equal(ok, true);
  assert.deepEqual(calls[0], ["network", "inspect", "net"]);
  assert.ok(!calls.some((a) => a[1] === "create"), "must not create when the network exists");
});

test("ensureSandboxNetwork: missing network → creates it with the MTU opt", async () => {
  const calls: Array<string[]> = [];
  const exec = (_file: string, args: string[]) => {
    calls.push(args);
    if (args[1] === "inspect") return Promise.reject(new Error("No such network"));
    return Promise.resolve({ stdout: "net" });
  };
  const ok = await ensureSandboxNetwork("net", "1400", exec);
  assert.equal(ok, true);
  const create = calls.find((a) => a[1] === "create");
  assert.ok(create, "must create the network when missing");
  assert.ok(create!.includes("--opt"), "must pass --opt");
  assert.ok(
    create!.includes("com.docker.network.driver.mtu=1400"),
    "must set the MTU driver opt to the given value",
  );
  assert.ok(create!.includes("net"), "must create the named network");
});

test("ensureSandboxNetwork: create failure → returns false (best-effort, non-fatal)", async () => {
  const exec = (_file: string, args: string[]) =>
    args[1] === "inspect"
      ? Promise.reject(new Error("missing"))
      : Promise.reject(new Error("create failed"));
  const ok = await ensureSandboxNetwork("net", "1400", exec as Parameters<typeof ensureSandboxNetwork>[2]);
  assert.equal(ok, false);
});

// ─── Concurrency env-var ─────────────────────────────────────────────────────

test("parseConcurrency: defaults to 1 when AGENTIC_CONCURRENCY is not set", () => {
  const saved = process.env.AGENTIC_CONCURRENCY;
  delete process.env.AGENTIC_CONCURRENCY;
  try {
    assert.equal(parseConcurrency(), 1);
  } finally {
    if (saved !== undefined) process.env.AGENTIC_CONCURRENCY = saved;
  }
});

test("parseConcurrency: reads AGENTIC_CONCURRENCY=3", () => {
  const saved = process.env.AGENTIC_CONCURRENCY;
  process.env.AGENTIC_CONCURRENCY = "3";
  try {
    assert.equal(parseConcurrency(), 3);
  } finally {
    if (saved !== undefined) process.env.AGENTIC_CONCURRENCY = saved;
    else delete process.env.AGENTIC_CONCURRENCY;
  }
});

test("parseConcurrency: invalid value falls back to 1", () => {
  const saved = process.env.AGENTIC_CONCURRENCY;
  process.env.AGENTIC_CONCURRENCY = "bad";
  try {
    assert.equal(parseConcurrency(), 1);
  } finally {
    if (saved !== undefined) process.env.AGENTIC_CONCURRENCY = saved;
    else delete process.env.AGENTIC_CONCURRENCY;
  }
});

// ─── withRetry ───────────────────────────────────────────────────────────────

test("withRetry: resolves immediately when fn succeeds on first attempt", async () => {
  const sleeps: number[] = [];
  const result = await withRetry(() => Promise.resolve(42), {
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
  });
  assert.equal(result, 42);
  assert.deepEqual(sleeps, [], "no sleep when fn succeeds first time");
});

test("withRetry: retries on failure and resolves when fn eventually succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const result = await withRetry(
    () => {
      calls++;
      if (calls < 3) return Promise.reject(new Error("transient"));
      return Promise.resolve("ok");
    },
    {
      maxAttempts: 4,
      baseDelayMs: 100,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3, "fn called exactly 3 times");
  assert.equal(sleeps.length, 2, "slept between each failed attempt");
});

test("withRetry: throws last error after maxAttempts exhausted", async () => {
  let calls = 0;
  const err = new Error("persistent failure");
  await assert.rejects(
    () =>
      withRetry(() => { calls++; return Promise.reject(err); }, {
        maxAttempts: 3,
        baseDelayMs: 10,
        sleep: () => Promise.resolve(),
      }),
    (thrown: Error) => thrown === err,
  );
  assert.equal(calls, 3, "fn tried exactly maxAttempts times");
});

test("withRetry: sleeps with exponential backoff between attempts", async () => {
  const sleeps: number[] = [];
  await assert.rejects(
    () =>
      withRetry(() => Promise.reject(new Error("fail")), {
        maxAttempts: 4,
        baseDelayMs: 50,
        sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      }),
  );
  assert.deepEqual(sleeps, [50, 100, 200], "delays double each retry (2^0, 2^1, 2^2 * baseDelayMs)");
});

test("withRetry: does not sleep after the final failed attempt", async () => {
  const sleeps: number[] = [];
  await assert.rejects(
    () =>
      withRetry(() => Promise.reject(new Error("fail")), {
        maxAttempts: 2,
        baseDelayMs: 100,
        sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      }),
  );
  assert.equal(sleeps.length, 1, "only sleeps between attempts, not after the last failure");
});

// ─── Conflicting PR (issue #23) ──────────────────────────────────────────────

test("conflicting PR does not keep loop alive — Stop emitted when nothing else pending", () => {
  const state = base({
    issues: [{ id: 1, labels: [], blockedBy: [] }],
    prs: [{ issue: 1, ciStatus: "conflicting" as CiStatus, merged: false }],
    policy: { concurrency: 1, mode: "afk" },
  });
  const actions = reduce(state, { type: "Tick" });
  assert.ok(actions.some((a) => a.type === "Stop"), "conflicting PR must not block Stop");
});

test("pending + conflicting PRs: pending keeps loop alive", () => {
  const state = base({
    issues: [],
    prs: [
      { issue: 1, ciStatus: "conflicting" as CiStatus, merged: false },
      { issue: 2, ciStatus: "pending" as CiStatus, merged: false },
    ],
    policy: { concurrency: 1, mode: "afk" },
  });
  const actions = reduce(state, { type: "Tick" });
  assert.ok(!actions.some((a) => a.type === "Stop"), "pending PR keeps loop alive even with a conflicting sibling");
});

// ─── resetAgentBranch (issue #23) ────────────────────────────────────────────

test("resetAgentBranch: deletes local then remote branch for the issue", async () => {
  const calls: string[][] = [];
  const gitRun = (args: string[]) => { calls.push(args); return Promise.resolve(); };
  await resetAgentBranch(23, gitRun);
  const localDelete = calls.find((a) => a[0] === "branch" && a.includes("-D") && a.includes("agent/issue-23"));
  const remoteDelete = calls.find((a) => a[0] === "push" && a.includes("--delete") && a.includes("agent/issue-23"));
  assert.ok(localDelete, "should delete local branch agent/issue-23");
  assert.ok(remoteDelete, "should delete remote branch agent/issue-23");
});

test("resetAgentBranch: swallows errors when branch does not exist", async () => {
  const gitRun = () => Promise.reject(new Error("branch not found"));
  await assert.doesNotReject(() => resetAgentBranch(23, gitRun));
});

// ─── refreshBase (issue #28) ─────────────────────────────────────────────────

test("refreshBase: fetches origin then hard-resets local base to origin/<base>", async () => {
  const calls: string[][] = [];
  const gitRun = (args: string[]) => { calls.push(args); return Promise.resolve(); };
  await refreshBase("main", gitRun);
  assert.deepEqual(calls[0], ["fetch", "origin", "main"], "must fetch origin first");
  const reset = calls.find((a) => a[0] === "reset" && a.includes("--hard") && a.includes("origin/main"));
  assert.ok(reset, "must hard-reset local base to origin/main");
  // Ordering: fetch precedes reset so the reset targets fresh remote state.
  assert.ok(calls.indexOf(reset!) > 0, "reset must come after fetch");
});

test("refreshBase: respects a non-default base branch", async () => {
  const calls: string[][] = [];
  const gitRun = (args: string[]) => { calls.push(args); return Promise.resolve(); };
  await refreshBase("develop", gitRun);
  assert.deepEqual(calls[0], ["fetch", "origin", "develop"]);
  assert.ok(calls.some((a) => a[0] === "reset" && a.includes("origin/develop")));
});

test("refreshBase: a fetch failure is retried, then swallowed without crashing", async () => {
  let fetchAttempts = 0;
  const gitRun = (args: string[]) => {
    if (args[0] === "fetch") { fetchAttempts++; return Promise.reject(new Error("network blip")); }
    return Promise.resolve();
  };
  // Inject a no-op sleep so the retry backoff does not slow the test.
  await assert.doesNotReject(() => refreshBase("main", gitRun, { sleep: () => Promise.resolve() }));
  assert.ok(fetchAttempts > 1, "fetch should be retried more than once");
});
// ─── smee signature handling (issue #26) ─────────────────────────────────────

const sigFor = (secret: string, raw: string) =>
  `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

test("classifyDelivery: no secret configured → no-secret", () => {
  assert.equal(classifyDelivery(undefined, "{}", "sha256=whatever"), "no-secret");
});

test("classifyDelivery: secret set but no signature header → missing-signature", () => {
  assert.equal(classifyDelivery("s", "{}", undefined), "missing-signature");
});

test("classifyDelivery: matching signature → verified", () => {
  const raw = '{"action":"closed"}';
  assert.equal(classifyDelivery("s", raw, sigFor("s", raw)), "verified");
});

test("classifyDelivery: wrong signature → mismatch (but caller still proceeds)", () => {
  assert.equal(classifyDelivery("s", '{"action":"closed"}', sigFor("s", "tampered")), "mismatch");
});

test("classifyDelivery: smee number reformatting yields mismatch on a genuine body", () => {
  // GitHub signs the raw bytes; smee re-serializes the parsed body, reformatting
  // numbers (1.0→1). The verdict is 'mismatch' even though the delivery is real
  // — this is exactly why the check is advisory, not a gate (#26).
  const rawFromGitHub = '{"id":1.0}';
  const reserialized = JSON.stringify(JSON.parse(rawFromGitHub)); // "{\"id\":1}"
  assert.notEqual(rawFromGitHub, reserialized);
  assert.equal(classifyDelivery("s", reserialized, sigFor("s", rawFromGitHub)), "mismatch");
});

test("validateSignature: rejects a signature of the wrong length without throwing", () => {
  assert.equal(validateSignature("s", "{}", "sha256=short"), false);
});

test("parseSmeeEvent: reads headers from smee's TOP-LEVEL keys (real shape, #26)", () => {
  // smee flattens webhook headers to the top level beside body/query/timestamp,
  // NOT under a `headers` key. This is the live-confirmed payload shape.
  const raw = JSON.stringify({
    host: "smee.io",
    "x-github-event": "pull_request",
    "x-github-delivery": "ed95b190-6faa-11f1",
    "x-hub-signature-256": "sha256=abc",
    body: { action: "closed", pull_request: { merged: true, head: { ref: "agent/issue-9998" } } },
    query: {},
    timestamp: 1782291587870,
  });
  const ev = parseSmeeEvent(raw);
  assert.equal(ev.headers["x-github-event"], "pull_request");
  assert.equal(ev.deliveryId, "ed95b190-6faa-11f1");
  assert.equal(ev.headers["x-hub-signature-256"], "sha256=abc");
  // body is unwrapped; smee wrapper fields are not leaked as headers
  assert.equal((ev.body as { action: string }).action, "closed");
  assert.equal(ev.headers["timestamp"], undefined);
  assert.equal(ev.headers["body"], undefined);
});

test("parseSmeeEvent: still supports a nested headers object (relay compatibility)", () => {
  const raw = JSON.stringify({
    headers: { "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": "d1" },
    body: { action: "opened" },
  });
  const ev = parseSmeeEvent(raw);
  assert.equal(ev.headers["x-github-event"], "pull_request"); // lowercased
  assert.equal(ev.deliveryId, "d1");
});

// ─── Event-driven loop (issue #5) ────────────────────────────────────────────

test("duplicate PrMerged for already-processed PR emits no StartSandbox", () => {
  // Simulate: PR #1 merged, issue #2 relabeled and sandbox already started.
  const mergedPr = { issue: 1, ciStatus: "success" as CiStatus, merged: true };
  const state = base({
    issues: [{ id: 2, labels: [READY_LABEL], blockedBy: [1] }],
    prs: [mergedPr],
    inFlight: [2], // sandbox already running for #2
  });

  // A duplicate PrMerged delivery must never emit StartSandbox directly.
  const prMergedActions = reduce(state, { type: "PrMerged", pr: mergedPr });
  assert.ok(
    !prMergedActions.some((a) => a.type === "StartSandbox"),
    "PrMerged never emits StartSandbox directly",
  );

  // A subsequent Tick must not restart #2 — it is already in-flight.
  const tickActions = reduce(state, { type: "Tick" });
  assert.ok(
    !tickActions.some((a) => a.type === "StartSandbox"),
    "in-flight issue not restarted after duplicate PrMerged",
  );
  assert.ok(
    !tickActions.some((a) => a.type === "Stop"),
    "in-flight work keeps loop alive",
  );
});

test("nothing ready but in-flight sandbox -> no Stop (keep listening)", () => {
  // No issues in the queue, but a sandbox is running — the loop must stay alive.
  const state = base({
    issues: [],
    prs: [],
    inFlight: [1],
  });
  const actions = reduce(state, { type: "Tick" });
  assert.ok(
    !actions.some((a) => a.type === "Stop"),
    "in-flight sandbox prevents Stop",
  );
  assert.deepEqual(
    actions.filter((a) => a.type === "StartSandbox"),
    [],
    "no new work to start",
  );
});

// ─── demo: A blocks B — A starts first; after A merges, B enters ready-set ───

test("demo: A blocks B — A starts first; after A merges, B enters ready-set", () => {
  // Step 1: only A has ready-for-agent; B is blocked (no label yet)
  const step1 = base({
    issues: [
      { id: 1, labels: [READY_LABEL], blockedBy: [] },
      { id: 2, labels: [], blockedBy: [1] },
    ],
    prs: [],
  });
  assert.deepEqual(reduce(step1, { type: "Tick" }), [
    { type: "StartSandbox", issueId: 1 },
  ]);

  // Step 2: A's PR merges → reducer emits Relabel for B
  const mergedA = { issue: 1, ciStatus: "success" as CiStatus, merged: true };
  const step2 = base({
    issues: [
      { id: 1, labels: [], blockedBy: [] },
      { id: 2, labels: [], blockedBy: [1] },
    ],
    prs: [],
  });
  assert.deepEqual(reduce(step2, { type: "PrMerged", pr: mergedA }), [
    { type: "Relabel", issueId: 2, label: READY_LABEL },
  ]);

  // Step 3: orchestrator adds label; next Tick starts B (A's PR is merged in state)
  const step3 = base({
    issues: [
      { id: 1, labels: [], blockedBy: [] },
      { id: 2, labels: [READY_LABEL], blockedBy: [1] },
    ],
    prs: [mergedA],
  });
  assert.deepEqual(reduce(step3, { type: "Tick" }), [
    { type: "StartSandbox", issueId: 2 },
  ]);
});

// ─── parseOrchEnv ─────────────────────────────────────────────────────────────

test("parseOrchEnv: empty string returns {}", () => {
  assert.deepEqual(parseOrchEnv(""), {});
});

test("parseOrchEnv: comment-only lines are skipped", () => {
  assert.deepEqual(parseOrchEnv("# this is a comment\n# another\n"), {});
});

test("parseOrchEnv: blank lines are skipped", () => {
  assert.deepEqual(parseOrchEnv("\n\n\n"), {});
});

test("parseOrchEnv: KEY=value parses correctly", () => {
  assert.deepEqual(parseOrchEnv("GH_TOKEN=abc123"), { GH_TOKEN: "abc123" });
});

test("parseOrchEnv: blank value is preserved as empty string", () => {
  assert.deepEqual(parseOrchEnv("GH_TOKEN="), { GH_TOKEN: "" });
});

test("parseOrchEnv: multiple vars parsed in order", () => {
  const result = parseOrchEnv("GH_TOKEN=tok\nANTHROPIC_API_KEY=sk-key\n");
  assert.equal(result.GH_TOKEN, "tok");
  assert.equal(result.ANTHROPIC_API_KEY, "sk-key");
});

test("parseOrchEnv: comment lines mixed with vars are skipped", () => {
  const result = parseOrchEnv("# set this\nGH_TOKEN=mytoken\n# done\n");
  assert.deepEqual(result, { GH_TOKEN: "mytoken" });
});

// ─── resolveCredentials ───────────────────────────────────────────────────────

test("resolveCredentials: env-only credentials resolve", () => {
  const creds = resolveCredentials({ GH_TOKEN: "from-env" });
  assert.equal(creds.GH_TOKEN, "from-env");
});

test("resolveCredentials: orchestrator.env-only credentials resolve", () => {
  const creds = resolveCredentials({}, { GH_TOKEN: "from-orch" });
  assert.equal(creds.GH_TOKEN, "from-orch");
});

test("resolveCredentials: env wins over orchestrator.env when both present", () => {
  const creds = resolveCredentials({ GH_TOKEN: "from-env" }, { GH_TOKEN: "from-orch" });
  assert.equal(creds.GH_TOKEN, "from-env");
});

test("resolveCredentials: missing credentials are undefined", () => {
  const creds = resolveCredentials({}, {});
  assert.equal(creds.GH_TOKEN, undefined);
  assert.equal(creds.GITHUB_TOKEN, undefined);
  assert.equal(creds.ANTHROPIC_API_KEY, undefined);
  assert.equal(creds.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("resolveCredentials: empty env value falls through to orchestrator.env", () => {
  const creds = resolveCredentials({ GH_TOKEN: "" }, { GH_TOKEN: "from-orch" });
  assert.equal(creds.GH_TOKEN, "from-orch");
});

test("resolveCredentials: AGENTIC_IN_CONTAINER set → cockpit true", () => {
  const creds = resolveCredentials({ AGENTIC_IN_CONTAINER: "1" });
  assert.equal(creds.cockpit, true);
});

test("resolveCredentials: AGENTIC_IN_CONTAINER absent → cockpit false", () => {
  const creds = resolveCredentials({});
  assert.equal(creds.cockpit, false);
});

test("resolveCredentials: resolves all four credential keys independently", () => {
  const creds = resolveCredentials(
    { GH_TOKEN: "gh-env", ANTHROPIC_API_KEY: "ak-env" },
    { GITHUB_TOKEN: "ght-orch", CLAUDE_CODE_OAUTH_TOKEN: "cco-orch" },
  );
  assert.equal(creds.GH_TOKEN, "gh-env");
  assert.equal(creds.ANTHROPIC_API_KEY, "ak-env");
  assert.equal(creds.GITHUB_TOKEN, "ght-orch");
  assert.equal(creds.CLAUDE_CODE_OAUTH_TOKEN, "cco-orch");
});
