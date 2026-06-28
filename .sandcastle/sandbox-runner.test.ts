/**
 * Unit tests for buildAgentInput — the pure function that selects agent
 * provider, image, network, prompt template, and prompt args based on the
 * runner's tier option and the issue being worked.
 * No Docker, GitHub, or network required.
 *
 * Run: npm test (picks up all *.test.ts files in the test script)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentInput } from "./sandbox-runner.ts";

const STUB_ISSUE = { number: 42, title: "Fix the bug", body: "Detailed description" };

test("default tier uses claude-code agent with sandcastle:local image", () => {
  const input = buildAgentInput({}, STUB_ISSUE);
  assert.equal(input.agent.name, "claude-code");
  assert.equal(input.imageName, "sandcastle:local");
  assert.equal(input.copyToWorktree, undefined);
});

test("explicit claude tier uses claude-code agent", () => {
  const input = buildAgentInput({ tier: "claude" }, STUB_ISSUE);
  assert.equal(input.agent.name, "claude-code");
  assert.equal(input.imageName, "sandcastle:local");
  assert.equal(input.copyToWorktree, undefined);
});

test("local tier uses opencode agent with sandcastle-opencode:local image", () => {
  const input = buildAgentInput({ tier: "local" }, STUB_ISSUE);
  assert.equal(input.agent.name, "opencode");
  assert.equal(input.imageName, "sandcastle-opencode:local");
  assert.deepEqual(input.copyToWorktree, ["opencode.json"]);
});

test("local tier delivers opencode.json via copyToWorktree", () => {
  const input = buildAgentInput({ tier: "local" }, STUB_ISSUE);
  assert.ok(Array.isArray(input.copyToWorktree), "copyToWorktree should be an array");
  assert.ok(input.copyToWorktree!.includes("opencode.json"), "opencode.json must be in copyToWorktree");
});

test("local tier installs opencode config into the global config dir", () => {
  // opencode resolves its Ollama provider from ~/.config/opencode, not the
  // worktree cwd; without this hook the provider never resolves and every
  // iteration is an empty turn. Lock in that the config is relocated to HOME.
  const input = buildAgentInput({ tier: "local" }, STUB_ISSUE);
  assert.ok(Array.isArray(input.onSandboxReady), "onSandboxReady should be an array");
  const cmds = input.onSandboxReady!.map((h) => h.command).join("\n");
  assert.match(cmds, /\.config\/opencode/, "must target opencode's global config dir");
  assert.match(cmds, /opencode\.json/, "must install the opencode.json config");
});

test("claude tier has no onSandboxReady hook", () => {
  const input = buildAgentInput({ tier: "claude" }, STUB_ISSUE);
  assert.equal(input.onSandboxReady, undefined);
});

test("claude tier respects custom imageName", () => {
  const input = buildAgentInput({ imageName: "my-sandcastle:v2" }, STUB_ISSUE);
  assert.equal(input.imageName, "my-sandcastle:v2");
});

test("local tier respects custom localImageName", () => {
  const input = buildAgentInput({ tier: "local", localImageName: "my-opencode:latest" }, STUB_ISSUE);
  assert.equal(input.imageName, "my-opencode:latest");
});

test("local tier defaults to ollama/qwen3-coder:30b model", () => {
  const input = buildAgentInput({ tier: "local" }, STUB_ISSUE);
  assert.equal(input.agent.name, "opencode");
});

test("claude tier uses the claude prompt template", () => {
  const input = buildAgentInput({ tier: "claude" }, STUB_ISSUE);
  assert.ok(
    input.promptFile.endsWith("prompt-claude.md"),
    `expected prompt-claude.md, got ${input.promptFile}`,
  );
});

test("local tier uses the local prompt template", () => {
  const input = buildAgentInput({ tier: "local" }, STUB_ISSUE);
  assert.ok(
    input.promptFile.endsWith("prompt-local.md"),
    `expected prompt-local.md, got ${input.promptFile}`,
  );
});

test("promptArgs include issue number, title, and body", () => {
  const issue = { number: 99, title: "Test Issue", body: "Some body text" };
  const input = buildAgentInput({}, issue);
  assert.equal(input.promptArgs["ISSUE_NUMBER"], "99");
  assert.equal(input.promptArgs["ISSUE_TITLE"], "Test Issue");
  assert.equal(input.promptArgs["ISSUE_BODY"], "Some body text");
});

test("promptArgs ISSUE_BODY defaults to (no body) when body is empty", () => {
  const input = buildAgentInput({}, { number: 1, title: "T", body: "" });
  assert.equal(input.promptArgs["ISSUE_BODY"], "(no body)");
});

test("network is forwarded from RunnerOptions", () => {
  const input = buildAgentInput({ network: "agentic-sandbox-net" }, STUB_ISSUE);
  assert.equal(input.network, "agentic-sandbox-net");
});

test("network is undefined when not provided", () => {
  const input = buildAgentInput({}, STUB_ISSUE);
  assert.equal(input.network, undefined);
});
