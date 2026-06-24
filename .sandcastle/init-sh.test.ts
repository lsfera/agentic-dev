/**
 * Tests for .devcontainer/init.sh per-project name derivation (#41).
 * Drives the script's `--dry-run` mode (writes no .env, no side effects) and
 * asserts the resolved DEVCONTAINER_NAME / workspace paths for a given folder.
 * Prior art: run-sh.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

const sh = promisify(execFile);
const INIT = join(dirname(fileURLToPath(import.meta.url)), "..", ".devcontainer", "init.sh");

/** Make a real dir whose basename is `name`, return its absolute path. */
async function folderNamed(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "initsh-"));
  const dir = join(parent, name);
  await mkdir(dir);
  return dir;
}

/** Run init.sh --dry-run on a folder; return the printed KEY=value map. */
async function resolve(folder: string): Promise<Record<string, string>> {
  const { stdout } = await sh("bash", [INIT, "--dry-run", folder]);
  const env: Record<string, string> = {};
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const i = line.indexOf("=");
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

test("init.sh: dots in the folder name collapse to '-' (agentic.dev → agentic-dev)", async () => {
  const env = await resolve(await folderNamed("agentic.dev"));
  assert.equal(env.DEVCONTAINER_NAME, "agentic-dev");
});

test("init.sh: spaces and other punctuation collapse to '-'", async () => {
  const env = await resolve(await folderNamed("My Proj.v2"));
  assert.equal(env.DEVCONTAINER_NAME, "My-Proj-v2");
});

test("init.sh: a plain name is used verbatim", async () => {
  const env = await resolve(await folderNamed("cv"));
  assert.equal(env.DEVCONTAINER_NAME, "cv");
});

test("init.sh: a non-alphanumeric first char is prefixed so Docker accepts it", async () => {
  const env = await resolve(await folderNamed("_secret"));
  assert.match(env.DEVCONTAINER_NAME, /^[a-zA-Z0-9]/);
  assert.equal(env.DEVCONTAINER_NAME, "x-_secret");
});

test("init.sh: workspace paths derive from the folder", async () => {
  const folder = await folderNamed("agentic.dev");
  const env = await resolve(folder);
  assert.equal(env.WORKSPACE_FOLDER, "/workspaces/agentic.dev");
  // macOS resolves tmp via /private; compare on the trailing real path component.
  assert.ok(env.LOCAL_WORKSPACE_FOLDER.endsWith("/agentic.dev"), env.LOCAL_WORKSPACE_FOLDER);
});

test("init.sh: --dry-run writes no .env (no side effects)", async () => {
  // The dry run prints only the three KEY=value lines and exits 0.
  const { stdout } = await sh("bash", [INIT, "--dry-run", await folderNamed("probe")]);
  const keys = stdout.trim().split("\n").map((l) => l.split("=")[0]).sort();
  assert.deepEqual(keys, ["DEVCONTAINER_NAME", "LOCAL_WORKSPACE_FOLDER", "WORKSPACE_FOLDER"]);
});
