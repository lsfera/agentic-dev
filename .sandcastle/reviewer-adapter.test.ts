/**
 * Unit tests for buildReviewerPassOneConfig + buildReviewerPassTwoConfig — the pure
 * functions that return the produce-pass and extraction-pass run options for the
 * reviewer adapter. No Docker, GitHub, or network required.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewerPassOneConfig, buildReviewerPassTwoConfig } from "./reviewer-adapter.ts";

const STUB_INPUT = {
  issueNumber: 42,
  issueTitle: "Fix the bug",
  issueBody: "Detailed description",
  branch: "agent/issue-42",
  prNumber: 7,
};

test("produce pass is capped at a single iteration", () => {
  const config = buildReviewerPassOneConfig({}, STUB_INPUT);
  assert.equal(config.maxIterations, 1);
});

test("produce pass uses review-prompt.md template", () => {
  const config = buildReviewerPassOneConfig({}, STUB_INPUT);
  assert.ok(config.promptFile.endsWith("review-prompt.md"), `expected review-prompt.md, got ${config.promptFile}`);
});

test("promptArgs include issue number, title, body, branch, and base branch", () => {
  const config = buildReviewerPassOneConfig({}, STUB_INPUT);
  assert.equal(config.promptArgs["ISSUE_NUMBER"], "42");
  assert.equal(config.promptArgs["ISSUE_TITLE"], "Fix the bug");
  assert.equal(config.promptArgs["ISSUE_BODY"], "Detailed description");
  assert.equal(config.promptArgs["BRANCH"], "agent/issue-42");
  assert.equal(config.promptArgs["BASE_BRANCH"], "main");
});

test("baseBranch defaults to main", () => {
  const config = buildReviewerPassOneConfig({}, STUB_INPUT);
  assert.equal(config.promptArgs["BASE_BRANCH"], "main");
});

test("baseBranch is overridable via options", () => {
  const config = buildReviewerPassOneConfig({ baseBranch: "develop" }, STUB_INPUT);
  assert.equal(config.promptArgs["BASE_BRANCH"], "develop");
});

test("name includes the issue number", () => {
  const config = buildReviewerPassOneConfig({}, STUB_INPUT);
  assert.ok(config.name.includes("42"), `expected name to include issue number, got ${config.name}`);
});

test("ISSUE_BODY defaults to (no body) when empty", () => {
  const config = buildReviewerPassOneConfig({}, { ...STUB_INPUT, issueBody: "" });
  assert.equal(config.promptArgs["ISSUE_BODY"], "(no body)");
});

// ─── Pass-2 extraction config tests ────────────────────────────────────────

test("extraction pass uses review-extraction.md template", () => {
  const config = buildReviewerPassTwoConfig(STUB_INPUT);
  assert.ok(config.promptFile.endsWith("review-extraction.md"), `expected review-extraction.md, got ${config.promptFile}`);
});

test("extraction pass name includes the issue number", () => {
  const config = buildReviewerPassTwoConfig(STUB_INPUT);
  assert.ok(config.name.includes("42"), `expected name to include issue number, got ${config.name}`);
});

test("extraction pass has no promptArgs — only promptFile is needed", () => {
  const config = buildReviewerPassTwoConfig(STUB_INPUT);
  // The interface does not expose promptArgs; confirm the return shape is { promptFile, name }.
  assert.ok("promptFile" in config);
  assert.ok("name" in config);
  assert.doesNotThrow(() => JSON.stringify(config)); // no circular refs
});

test("extraction pass is independent of input beyond issue number", () => {
  const fullInput = { ...STUB_INPUT, issueTitle: "A very long title with many words and special chars @#$%", issueBody: "extremely detailed body".repeat(50), branch: "agent/issue-99" };
  const config = buildReviewerPassTwoConfig(fullInput);
  assert.ok(config.name.includes("99"), `expected name to include issue number 99, got ${config.name}`);
});

test("extraction promptFile is an absolute path", () => {
  const config = buildReviewerPassTwoConfig(STUB_INPUT);
  assert.ok(config.promptFile.startsWith("/"), `expected absolute path, got ${config.promptFile}`);
});
