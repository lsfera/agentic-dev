/**
 * Unit tests for buildAgentInput — the pure function that selects agent
 * provider, image, and worktree files based on the runner's tier option.
 * No Docker, GitHub, or network required.
 *
 * Run: npm test (picks up all *.test.ts files in the test script)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentInput } from "./sandbox-runner.ts";

test("default tier uses claude-code agent with sandcastle:local image", () => {
  const input = buildAgentInput({});
  assert.equal(input.agent.name, "claude-code");
  assert.equal(input.imageName, "sandcastle:local");
  assert.equal(input.copyToWorktree, undefined);
});

test("explicit claude tier uses claude-code agent", () => {
  const input = buildAgentInput({ tier: "claude" });
  assert.equal(input.agent.name, "claude-code");
  assert.equal(input.imageName, "sandcastle:local");
  assert.equal(input.copyToWorktree, undefined);
});

test("local tier uses opencode agent with sandcastle-opencode:local image", () => {
  const input = buildAgentInput({ tier: "local" });
  assert.equal(input.agent.name, "opencode");
  assert.equal(input.imageName, "sandcastle-opencode:local");
  assert.deepEqual(input.copyToWorktree, ["opencode.json"]);
});

test("local tier delivers opencode.json via copyToWorktree", () => {
  const input = buildAgentInput({ tier: "local" });
  assert.ok(Array.isArray(input.copyToWorktree), "copyToWorktree should be an array");
  assert.ok(input.copyToWorktree!.includes("opencode.json"), "opencode.json must be in copyToWorktree");
});

test("local tier installs opencode config into the global config dir", () => {
  // opencode resolves its Ollama provider from ~/.config/opencode, not the
  // worktree cwd; without this hook the provider never resolves and every
  // iteration is an empty turn. Lock in that the config is relocated to HOME.
  const input = buildAgentInput({ tier: "local" });
  assert.ok(Array.isArray(input.onSandboxReady), "onSandboxReady should be an array");
  const cmds = input.onSandboxReady!.map((h) => h.command).join("\n");
  assert.match(cmds, /\.config\/opencode/, "must target opencode's global config dir");
  assert.match(cmds, /opencode\.json/, "must install the opencode.json config");
});

test("claude tier has no onSandboxReady hook", () => {
  const input = buildAgentInput({ tier: "claude" });
  assert.equal(input.onSandboxReady, undefined);
});

test("claude tier respects custom imageName", () => {
  const input = buildAgentInput({ imageName: "my-sandcastle:v2" });
  assert.equal(input.imageName, "my-sandcastle:v2");
});

test("local tier respects custom localImageName", () => {
  const input = buildAgentInput({ tier: "local", localImageName: "my-opencode:latest" });
  assert.equal(input.imageName, "my-opencode:latest");
});

test("local tier defaults to ollama/qwen3-coder:30b model", () => {
  const input = buildAgentInput({ tier: "local" });
  assert.equal(input.agent.name, "opencode");
});
