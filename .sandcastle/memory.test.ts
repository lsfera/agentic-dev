/**
 * Unit tests for memory.ts — pure formatting/parsing/selection logic for the
 * cross-run memory store (ADR-0022). No I/O required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMemoryComment,
  parseMemoryComment,
  parseMemoryTags,
  buildOutcomeEntry,
  selectMemoryContext,
  renderMemoryContext,
  type MemoryEntry,
} from "./memory.ts";

// ─── formatMemoryComment / parseMemoryComment round-trip ──────────────────

test("formatMemoryComment includes the marker, category, fields, and body", () => {
  const entry: MemoryEntry = {
    category: "gotcha",
    fields: { Issue: "#48" },
    body: "The default bridge MTU black-holes streaming under DooD.",
  };
  const comment = formatMemoryComment(entry);
  assert.match(comment, /<!-- agentic-memory -->/);
  assert.match(comment, /\*\*Category:\*\* gotcha/);
  assert.match(comment, /\*\*Issue:\*\* #48/);
  assert.match(comment, /The default bridge MTU black-holes streaming under DooD\./);
});

test("parseMemoryComment round-trips formatMemoryComment's output", () => {
  const entry: MemoryEntry = {
    category: "repo-convention",
    fields: { Scope: "tests" },
    body: "Always use node:test, never a third-party runner.",
  };
  const parsed = parseMemoryComment(formatMemoryComment(entry));
  assert.deepEqual(parsed, entry);
});

test("parseMemoryComment returns null for a comment with no marker", () => {
  assert.equal(parseMemoryComment("Implemented in an isolated sandbox; opened https://..."), null);
});

test("parseMemoryComment returns null for an unrecognized category (dropped, not coerced)", () => {
  const body = ["<!-- agentic-memory -->", "**Category:** preference", "", "Some fact."].join("\n");
  assert.equal(parseMemoryComment(body), null);
});

test("parseMemoryComment handles a multi-line body", () => {
  const body = [
    "<!-- agentic-memory -->",
    "**Category:** outcome",
    "**Issue:** #82",
    "**Result:** succeeded",
    "**Attempts:** 2",
    "",
    "Attempt 1 failed: sandbox timeout after 12 iterations.",
    "Attempt 2 succeeded.",
  ].join("\n");
  const parsed = parseMemoryComment(body);
  assert.equal(parsed?.category, "outcome");
  assert.equal(parsed?.fields.Issue, "#82");
  assert.equal(parsed?.fields.Attempts, "2");
  assert.equal(
    parsed?.body,
    "Attempt 1 failed: sandbox timeout after 12 iterations.\nAttempt 2 succeeded.",
  );
});

// ─── parseMemoryTags ────────────────────────────────────────────────────────

test("parseMemoryTags extracts a single gotcha tag", () => {
  const stdout = 'Some agent output.\n<gotcha>\nAlways set --network explicitly.\n</gotcha>\nDone.';
  const entries = parseMemoryTags(stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].category, "gotcha");
  assert.equal(entries[0].body, "Always set --network explicitly.");
});

test("parseMemoryTags extracts multiple tags of different categories in one turn", () => {
  const stdout = [
    "<repo-convention>Use tsx, not ts-node.</repo-convention>",
    "some other text",
    "<gotcha>CI needs GH_TOKEN scoped to repo, not org.</gotcha>",
  ].join("\n");
  const entries = parseMemoryTags(stdout);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.category).sort(), ["gotcha", "repo-convention"]);
});

test("parseMemoryTags drops an unclosed tag silently (fail-open)", () => {
  const stdout = "<gotcha>never closed";
  assert.deepEqual(parseMemoryTags(stdout), []);
});

test("parseMemoryTags drops an empty tag body", () => {
  const stdout = "<gotcha>   </gotcha>";
  assert.deepEqual(parseMemoryTags(stdout), []);
});

test("parseMemoryTags ignores <outcome> tags (orchestrator-only, never agent-emitted)", () => {
  const stdout = "<outcome>fabricated by the agent</outcome>";
  assert.deepEqual(parseMemoryTags(stdout), []);
});

test("parseMemoryTags returns [] when no tags are present", () => {
  assert.deepEqual(parseMemoryTags("just plain output, no tags"), []);
});

// ─── buildOutcomeEntry ──────────────────────────────────────────────────────

test("buildOutcomeEntry summarizes a clean single-attempt success", () => {
  const entry = buildOutcomeEntry({
    issueNumber: 82,
    prNumber: 85,
    attempts: [{ succeeded: true }],
  });
  assert.equal(entry.category, "outcome");
  assert.equal(entry.fields.Issue, "#82");
  assert.equal(entry.fields.PR, "#85");
  assert.equal(entry.fields.Result, "succeeded");
  assert.equal(entry.fields.Attempts, "1");
  assert.equal(entry.body, "Attempt 1 succeeded.");
});

test("buildOutcomeEntry accumulates a failed-then-succeeded attempt history", () => {
  const entry = buildOutcomeEntry({
    issueNumber: 82,
    prNumber: 85,
    attempts: [
      { succeeded: false, note: "sandbox timeout after 12 iterations" },
      { succeeded: true },
    ],
  });
  assert.equal(entry.fields.Result, "succeeded");
  assert.equal(entry.fields.Attempts, "2");
  assert.equal(
    entry.body,
    "Attempt 1 failed: sandbox timeout after 12 iterations\nAttempt 2 succeeded.",
  );
});

test("buildOutcomeEntry reports failed when retries are exhausted", () => {
  const entry = buildOutcomeEntry({
    issueNumber: 90,
    attempts: [
      { succeeded: false, note: "no commits" },
      { succeeded: false, note: "no commits" },
    ],
  });
  assert.equal(entry.fields.Result, "failed");
  assert.equal(entry.fields.PR, undefined);
});

test("buildOutcomeEntry omits PR field when no PR was opened", () => {
  const entry = buildOutcomeEntry({ issueNumber: 1, attempts: [{ succeeded: false }] });
  assert.equal("PR" in entry.fields, false);
});

// ─── selectMemoryContext ────────────────────────────────────────────────────

test("selectMemoryContext keeps all repo-convention entries uncapped", () => {
  const entries: MemoryEntry[] = Array.from({ length: 8 }, (_, i) => ({
    category: "repo-convention" as const,
    fields: {},
    body: `convention ${i}`,
  }));
  const selected = selectMemoryContext(entries);
  assert.equal(selected.length, 8);
});

test("selectMemoryContext caps gotcha at the last 5, keeping the newest", () => {
  const entries: MemoryEntry[] = Array.from({ length: 8 }, (_, i) => ({
    category: "gotcha" as const,
    fields: {},
    body: `gotcha ${i}`,
  }));
  const selected = selectMemoryContext(entries);
  assert.equal(selected.length, 5);
  assert.deepEqual(
    selected.map((e) => e.body),
    ["gotcha 3", "gotcha 4", "gotcha 5", "gotcha 6", "gotcha 7"],
  );
});

test("selectMemoryContext caps outcome at the last 5 independently of gotcha", () => {
  const gotchas: MemoryEntry[] = Array.from({ length: 3 }, (_, i) => ({
    category: "gotcha" as const,
    fields: {},
    body: `g${i}`,
  }));
  const outcomes: MemoryEntry[] = Array.from({ length: 7 }, (_, i) => ({
    category: "outcome" as const,
    fields: {},
    body: `o${i}`,
  }));
  const selected = selectMemoryContext([...gotchas, ...outcomes]);
  const selectedOutcomes = selected.filter((e) => e.category === "outcome");
  assert.equal(selectedOutcomes.length, 5);
  assert.equal(selectedOutcomes[0].body, "o2");
});

test("selectMemoryContext returns [] for no entries", () => {
  assert.deepEqual(selectMemoryContext([]), []);
});

// ─── renderMemoryContext ────────────────────────────────────────────────────

test("renderMemoryContext returns a placeholder for no entries", () => {
  assert.equal(renderMemoryContext([]), "(no prior memory for this repo)");
});

test("renderMemoryContext renders category and fields inline with the body", () => {
  const rendered = renderMemoryContext([
    { category: "gotcha", fields: { Issue: "#48" }, body: "MTU black-hole under DooD." },
  ]);
  assert.match(rendered, /^\[gotcha\] \(Issue: #48\) MTU black-hole under DooD\.$/);
});

test("renderMemoryContext separates multiple entries with a blank line", () => {
  const rendered = renderMemoryContext([
    { category: "repo-convention", fields: {}, body: "Use tsx." },
    { category: "gotcha", fields: {}, body: "Watch the MTU." },
  ]);
  assert.equal(rendered, "[repo-convention] Use tsx.\n\n[gotcha] Watch the MTU.");
});
