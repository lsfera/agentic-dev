/**
 * Unit tests for buildReviewerPassOneConfig — the pure function that returns
 * the produce-pass run options for the reviewer adapter.
 * No Docker, GitHub, or network required.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewerPassOneConfig } from "./reviewer-adapter.ts";

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
