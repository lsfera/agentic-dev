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

// ─── Demo: two-issue chain A blocks B ────────────────────────────────────────

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
