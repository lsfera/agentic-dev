/**
 * Tests for run.sh argument → env resolution (the /afk + /hitl steering layer).
 * Drives the script's hermetic `--dry-run` mode (no secrets, no orchestrator)
 * and asserts on the resolved AGENTIC_* env it prints.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const sh = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "run.sh");

/** Run run.sh --dry-run with args; return the AGENTIC_* env as a map. */
async function resolve(args: string[]): Promise<Record<string, string>> {
  const { stdout } = await sh("bash", [SCRIPT, ...args, "--dry-run"]);
  const env: Record<string, string> = {};
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const i = line.indexOf("=");
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

test("run.sh: bare afk → mode only, no tier/model overrides", async () => {
  const env = await resolve(["afk"]);
  assert.equal(env.AGENTIC_MODE, "afk");
  assert.equal(env.AGENTIC_TIER, undefined);
  assert.equal(env.AGENTIC_MODEL, undefined);
});

test("run.sh: positional local tier", async () => {
  const env = await resolve(["afk", "local"]);
  assert.equal(env.AGENTIC_MODE, "afk");
  assert.equal(env.AGENTIC_TIER, "local");
});

test("run.sh: local tier + bare model gets the ollama/ prefix", async () => {
  const env = await resolve(["afk", "local", "qwen2.5-coder:32b"]);
  assert.equal(env.AGENTIC_TIER, "local");
  assert.equal(env.AGENTIC_LOCAL_MODEL, "ollama/qwen2.5-coder:32b");
  assert.equal(env.AGENTIC_MODEL, undefined); // claude model untouched
});

test("run.sh: an already-prefixed local model is left as-is", async () => {
  const env = await resolve(["afk", "local", "ollama/qwen3-coder:30b"]);
  assert.equal(env.AGENTIC_LOCAL_MODEL, "ollama/qwen3-coder:30b");
});

test("run.sh: a bare model on the default (claude) tier sets AGENTIC_MODEL", async () => {
  const env = await resolve(["afk", "claude-opus-4-8"]);
  assert.equal(env.AGENTIC_MODEL, "claude-opus-4-8");
  assert.equal(env.AGENTIC_LOCAL_MODEL, undefined);
});

test("run.sh: flag form (--tier/--model) for hitl", async () => {
  const env = await resolve(["hitl", "--tier", "local", "--model", "qwen2.5-coder:32b"]);
  assert.equal(env.AGENTIC_MODE, "hitl");
  assert.equal(env.AGENTIC_TIER, "local");
  assert.equal(env.AGENTIC_LOCAL_MODEL, "ollama/qwen2.5-coder:32b");
});

test("run.sh: --base and --concurrency map to their env vars", async () => {
  const env = await resolve(["afk", "--base", "develop", "--concurrency", "2"]);
  assert.equal(env.AGENTIC_BASE_BRANCH, "develop");
  assert.equal(env.AGENTIC_CONCURRENCY, "2");
});

test("run.sh: missing mode exits non-zero", async () => {
  await assert.rejects(() => sh("bash", [SCRIPT, "--dry-run"]));
});

test("run.sh: unknown flag exits non-zero", async () => {
  await assert.rejects(() => sh("bash", [SCRIPT, "afk", "--bogus", "--dry-run"]));
});
