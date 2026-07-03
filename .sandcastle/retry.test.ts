/**
 * Unit tests for withRetry — the generic backoff-retry wrapper used both by
 * main.ts (transient gh/GitHub API failures) and sandbox-runner.ts (transient
 * agent-turn failures, gated by isTransientAgentError).
 *
 * Run: npm test (picks up all *.test.ts files in the test script)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "./retry.ts";

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

// ─── shouldRetry predicate ───────────────────────────────────────────────────

test("withRetry: shouldRetry=false throws immediately without further attempts", async () => {
  let calls = 0;
  const err = new Error("not worth retrying");
  await assert.rejects(
    () =>
      withRetry(() => { calls++; return Promise.reject(err); }, {
        maxAttempts: 4,
        baseDelayMs: 10,
        sleep: () => Promise.resolve(),
        shouldRetry: () => false,
      }),
    (thrown: Error) => thrown === err,
  );
  assert.equal(calls, 1, "fn called exactly once — no retries when shouldRetry is false");
});

test("withRetry: shouldRetry defaults to true (retries on any error) when omitted", async () => {
  let calls = 0;
  const result = await withRetry(
    () => { calls++; return calls < 2 ? Promise.reject(new Error("x")) : Promise.resolve("ok"); },
    { maxAttempts: 2, baseDelayMs: 10, sleep: () => Promise.resolve() },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});
