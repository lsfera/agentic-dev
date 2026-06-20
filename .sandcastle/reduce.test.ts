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
import { reduce, READY_LABEL, type State } from "./reduce.ts";

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

test("issue with an existing PR is not restarted", () => {
  const state = base({
    issues: [{ id: 1, labels: [READY_LABEL], blockedBy: [] }],
    prs: [{ issue: 1, ciStatus: "pending", merged: false }],
  });
  // No other ready work and nothing running -> quiet -> Stop.
  assert.deepEqual(reduce(state, { type: "Tick" }), [{ type: "Stop" }]);
});
