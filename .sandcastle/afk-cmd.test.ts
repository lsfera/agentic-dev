/**
 * Tests for the baked-in `afk` / `hitl` launchers (.devcontainer/afk). They drive
 * the script's `--print-target` mode, which resolves the mode/project-root/
 * LOCAL_WORKSPACE_FOLDER and prints them without launching the orchestrator.
 * Prior art: up-sh.test.ts, init-sh.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, writeFile, symlink, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";

const sh = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AFK = join(REPO_ROOT, ".devcontainer", "afk");

/** Run the launcher (at `bin`, name decides the mode) from `cwd` with --print-target. */
async function printTarget(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<Record<string, string>> {
  const { stdout } = await sh("bash", [bin, "--print-target"], {
    cwd,
    env: { ...process.env, LOCAL_WORKSPACE_FOLDER: "", ...env },
  });
  const out: Record<string, string> = {};
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const i = line.indexOf("=");
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** Build a throwaway project tree with an executable .sandcastle/run.sh stub. */
async function fakeProject(localWorkspaceFolder?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "afk-"));
  await mkdir(join(root, ".sandcastle"), { recursive: true });
  const runSh = join(root, ".sandcastle", "run.sh");
  await writeFile(runSh, "#!/usr/bin/env bash\necho stub\n");
  await chmod(runSh, 0o755);
  if (localWorkspaceFolder !== undefined) {
    await mkdir(join(root, ".devcontainer"), { recursive: true });
    await writeFile(
      join(root, ".devcontainer", ".env"),
      `DEVCONTAINER_NAME=fake\nLOCAL_WORKSPACE_FOLDER=${localWorkspaceFolder}\n`,
    );
  }
  return root;
}

test("afk: mode is 'afk' and the project root is found", async () => {
  const out = await printTarget(AFK, REPO_ROOT);
  assert.equal(out.MODE, "afk");
  assert.equal(out.ROOT, REPO_ROOT);
});

test("hitl symlink dispatches review mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "afk-bin-"));
  const link = join(dir, "hitl");
  await symlink(AFK, link);
  const out = await printTarget(link, REPO_ROOT);
  assert.equal(out.MODE, "hitl");
});

test("afk: finds the root by walking up from a subdirectory", async () => {
  const out = await printTarget(AFK, join(REPO_ROOT, ".sandcastle"));
  assert.equal(out.ROOT, REPO_ROOT);
});

test("afk: reads LOCAL_WORKSPACE_FOLDER from .devcontainer/.env when unset", async () => {
  const root = await fakeProject("/Users/someone/projects/widget");
  const out = await printTarget(AFK, root);
  assert.equal(out.LOCAL_WORKSPACE_FOLDER, "/Users/someone/projects/widget");
});

test("afk: an already-set LOCAL_WORKSPACE_FOLDER wins over .devcontainer/.env", async () => {
  const root = await fakeProject("/Users/someone/projects/widget");
  const out = await printTarget(AFK, root, { LOCAL_WORKSPACE_FOLDER: "/explicit/path" });
  assert.equal(out.LOCAL_WORKSPACE_FOLDER, "/explicit/path");
});

test("afk: outside any project, exits non-zero", async () => {
  const empty = await mkdtemp(join(tmpdir(), "afk-empty-"));
  await assert.rejects(() =>
    sh("bash", [AFK, "--print-target"], {
      cwd: empty,
      env: { ...process.env, LOCAL_WORKSPACE_FOLDER: "", AGENTIC_ORCHESTRATOR_HOME: "/nonexistent" },
    }),
  );
});

test("afk: a non-vendoring project (.devcontainer only) falls back to the baked run.sh", async () => {
  // Project root carries .devcontainer but no .sandcastle/run.sh (adopter using
  // the baked orchestrator, ADR-0016).
  const root = await mkdtemp(join(tmpdir(), "afk-baked-"));
  await mkdir(join(root, ".devcontainer"), { recursive: true });
  // A stand-in for /opt/agentic-orchestrator with an executable run.sh.
  const baked = await mkdtemp(join(tmpdir(), "afk-opt-"));
  const bakedRun = join(baked, "run.sh");
  await writeFile(bakedRun, "#!/usr/bin/env bash\necho baked\n");
  await chmod(bakedRun, 0o755);
  const out = await printTarget(AFK, root, { AGENTIC_ORCHESTRATOR_HOME: baked });
  // $PWD inside the script is canonicalized (macOS /var → /private/var), so
  // compare against the realpath of the tmpdir.
  assert.equal(out.ROOT, await realpath(root));
  assert.equal(out.RUN_SH, bakedRun);
});

test("afk: project root found but neither workspace nor baked run.sh exists → error", async () => {
  const root = await mkdtemp(join(tmpdir(), "afk-norun-"));
  await mkdir(join(root, ".devcontainer"), { recursive: true });
  await assert.rejects(() =>
    sh("bash", [AFK, "--print-target"], {
      cwd: root,
      env: { ...process.env, LOCAL_WORKSPACE_FOLDER: "", AGENTIC_ORCHESTRATOR_HOME: "/nonexistent" },
    }),
  );
});
