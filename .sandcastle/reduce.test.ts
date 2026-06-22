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
import { sweepOrphanedSandboxes, parseConcurrency } from "./main.ts";
import { SANDBOX_LABEL } from "./sandbox-runner.ts";

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
