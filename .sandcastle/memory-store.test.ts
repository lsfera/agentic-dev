/**
 * Unit tests for memory-store.ts — I/O orchestration for cross-run memory
 * (ADR-0022). Exercised against a plain stub (MemoryIssueSource is a narrow
 * structural interface), so these run with no real gh calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readMemoryContext, writeMemoryEntry, type MemoryIssueSource } from "./memory-store.ts";
import { formatMemoryComment } from "./memory.ts";

function stubIssues(overrides: Partial<MemoryIssueSource> = {}): MemoryIssueSource & {
  comments: string[];
  createdIssue: { title: string; body: string; labels: string[] } | null;
} {
  // A single mutable object shared between the closures and the caller — not a
  // spread copy, so a reassignment inside createIssue() (not just an array
  // push) is visible on the object the test holds a reference to.
  const state: MemoryIssueSource & {
    comments: string[];
    createdIssue: { title: string; body: string; labels: string[] } | null;
  } = {
    comments: [] as string[],
    createdIssue: null as { title: string; body: string; labels: string[] } | null,
    findIssueByLabel: overrides.findIssueByLabel ?? (async () => null),
    createIssue:
      overrides.createIssue ??
      (async (opts: { title: string; body: string; labels: string[] }) => {
        state.createdIssue = opts;
        return 101;
      }),
    listComments: overrides.listComments ?? (async () => state.comments),
    comment: overrides.comment ?? (async (_n: number, body: string) => { state.comments.push(body); }),
  };
  return state;
}

// ─── readMemoryContext ──────────────────────────────────────────────────────

test("readMemoryContext returns the placeholder when no memory issue exists", async () => {
  const issues = stubIssues({ findIssueByLabel: async () => null });
  const context = await readMemoryContext(issues);
  assert.equal(context, "(no prior memory for this repo)");
});

test("readMemoryContext parses and renders comments from the memory issue", async () => {
  const entryBody = formatMemoryComment({
    category: "repo-convention",
    fields: {},
    body: "Always use tsx, never ts-node.",
  });
  const issues = stubIssues({
    findIssueByLabel: async () => ({ number: 7 }),
    listComments: async () => [entryBody],
  });
  const context = await readMemoryContext(issues);
  assert.match(context, /Always use tsx, never ts-node\./);
});

test("readMemoryContext skips non-memory comments (e.g. 'opened PR' status comments)", async () => {
  const issues = stubIssues({
    findIssueByLabel: async () => ({ number: 7 }),
    listComments: async () => ["Implemented in an isolated sandbox; opened https://..."],
  });
  const context = await readMemoryContext(issues);
  assert.equal(context, "(no prior memory for this repo)");
});

test("readMemoryContext fails open — a findIssueByLabel throw degrades to the placeholder", async () => {
  const issues = stubIssues({
    findIssueByLabel: async () => { throw new Error("gh: rate limited"); },
  });
  const context = await readMemoryContext(issues);
  assert.equal(context, "(no prior memory for this repo)");
});

test("readMemoryContext fails open — a listComments throw degrades to the placeholder", async () => {
  const issues = stubIssues({
    findIssueByLabel: async () => ({ number: 7 }),
    listComments: async () => { throw new Error("gh: network error"); },
  });
  const context = await readMemoryContext(issues);
  assert.equal(context, "(no prior memory for this repo)");
});

// ─── writeMemoryEntry ───────────────────────────────────────────────────────

test("writeMemoryEntry auto-creates the pinned memory issue on first write", async () => {
  const issues = stubIssues({ findIssueByLabel: async () => null });
  await writeMemoryEntry(issues, { category: "gotcha", fields: {}, body: "Watch the MTU." });
  assert.ok(issues.createdIssue, "expected createIssue to be called");
  assert.match(issues.createdIssue!.title, /Agent memory/);
  assert.deepEqual(issues.createdIssue!.labels, ["agent:memory"]);
});

test("writeMemoryEntry does not create a new issue when one already exists", async () => {
  let created = false;
  const issues = stubIssues({
    findIssueByLabel: async () => ({ number: 7 }),
    createIssue: async () => { created = true; return 999; },
  });
  await writeMemoryEntry(issues, { category: "gotcha", fields: {}, body: "..." });
  assert.equal(created, false);
});

test("writeMemoryEntry posts a formatted comment carrying the marker", async () => {
  const issues = stubIssues({ findIssueByLabel: async () => ({ number: 7 }) });
  await writeMemoryEntry(issues, { category: "outcome", fields: { Issue: "#1" }, body: "Attempt 1 succeeded." });
  assert.equal(issues.comments.length, 1);
  assert.match(issues.comments[0], /<!-- agentic-memory -->/);
  assert.match(issues.comments[0], /\*\*Category:\*\* outcome/);
});

test("writeMemoryEntry fails open — a comment() throw is swallowed, not rethrown", async () => {
  const issues = stubIssues({
    findIssueByLabel: async () => ({ number: 7 }),
    comment: async () => { throw new Error("gh: 502"); },
  });
  // Must not throw.
  await writeMemoryEntry(issues, { category: "gotcha", fields: {}, body: "..." });
});

test("writeMemoryEntry fails open — a createIssue throw is swallowed, not rethrown", async () => {
  const issues = stubIssues({
    findIssueByLabel: async () => null,
    createIssue: async () => { throw new Error("gh: permission denied"); },
  });
  await writeMemoryEntry(issues, { category: "gotcha", fields: {}, body: "..." });
});
