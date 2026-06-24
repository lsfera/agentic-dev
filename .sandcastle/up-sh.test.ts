/**
 * Tests for up.sh argument handling (#42). Drives the slimmed wrapper's
 * `--dry-run` mode (resolves the container name + flags, touches no docker)
 * and asserts on what it prints. Prior art: run-sh.test.ts, init-sh.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const sh = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UP = join(REPO_ROOT, "up.sh");

/** Run up.sh <args> --dry-run; return the printed KEY=value map. */
async function dryRun(args: string[]): Promise<Record<string, string>> {
  const { stdout } = await sh("bash", [UP, ...args, "--dry-run"]);
  const out: Record<string, string> = {};
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const i = line.indexOf("=");
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

test("up.sh: dogfood repo resolves to the per-project container 'agentic-dev'", async () => {
  const out = await dryRun([REPO_ROOT]);
  assert.equal(out.CONTAINER, "agentic-dev");
  assert.ok(out.WS_ABS.endsWith("/agentic.dev"), out.WS_ABS);
  assert.equal(out.OPEN_CODE, "0");
});

test("up.sh: --code sets OPEN_CODE", async () => {
  const out = await dryRun([REPO_ROOT, "--code"]);
  assert.equal(out.OPEN_CODE, "1");
});

test("up.sh: -c is an alias for --code", async () => {
  const out = await dryRun([REPO_ROOT, "-c"]);
  assert.equal(out.OPEN_CODE, "1");
});

test("up.sh: a folder without its own .devcontainer is rejected", async () => {
  const empty = await mkdtemp(join(tmpdir(), "upsh-"));
  await assert.rejects(() => sh("bash", [UP, empty, "--dry-run"]));
});

test("up.sh: an unknown flag exits non-zero", async () => {
  await assert.rejects(() => sh("bash", [UP, REPO_ROOT, "--bogus", "--dry-run"]));
});
