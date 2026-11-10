/**
 * End-to-end smoke tests for the Effect orchestrator loop, driving the real
 * entrypoint (src/main.ts) as a subprocess against fake `gh`/`docker`/`git`
 * binaries on PATH. No network, GitHub, Docker or Claude involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "main.ts");
const TSX = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "tsx");

/** A temp project: fake bins (logging every call), a git repo, and ready.json. */
function fixture(readyJson: string) {
  const root = mkdtempSync(join(tmpdir(), "afk-loop-"));
  const bin = join(root, "bin");
  const work = join(root, "work");
  mkdirSync(bin);
  mkdirSync(work);
  const calls = join(root, "calls.log");
  writeFileSync(join(root, "ready.json"), readyJson);
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script(
    "gh",
    `case "$*" in
  *"--label ready-for-agent"*) cat "${join(root, "ready.json")}" ;;
  *"issue list"*|*"pr list"*) echo '[]' ;;
  *"issue view"*) echo '{"number":7,"title":"t","body":"b","labels":[]}' ;;
  *) echo ok ;;
esac`,
  );
  script("docker", "exit 0");
  script("git", "exit 0");
  execFileSync("git", ["init", "-q"], { cwd: work, env: { ...process.env } });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HEADROOM_MODE: "off",
  } as Record<string, string | undefined>;
  delete env.AGENTIC_IN_CONTAINER; // foreground mode
  return { root, work, calls, env };
}

test("main loop: nothing ready → logs 'done', sweeps, exits 0", async () => {
  const fx = fixture("[]");
  try {
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(TSX, [MAIN], { cwd: fx.work, env: fx.env });
      let text = "";
      child.stdout.on("data", (d) => (text += d));
      child.stderr.on("data", (d) => (text += d));
      child.on("close", (code) => resolve({ code, text }));
    });
    assert.equal(out.code, 0, out.text);
    assert.match(out.text, /nothing ready, nothing in flight — done/);
    const calls = readFileSync(fx.calls, "utf8");
    assert.match(calls, /gh label create agent:in-progress/, "lifecycle labels ensured at boot");
    assert.match(calls, /docker network inspect/, "sandbox network ensured");
    assert.equal((calls.match(/docker ps -a/g) ?? []).length, 2, "orphan sweep at startup and at shutdown");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("main loop: a ready issue is claimed; a failed sandbox is re-queued; SIGTERM interrupts cleanly", async () => {
  const fx = fixture('[{"number":7,"labels":[{"name":"ready-for-agent"}],"body":""}]');
  try {
    const out = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn(TSX, [MAIN], { cwd: fx.work, env: fx.env });
      let text = "";
      let killed = false;
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out:\n${text}`)); }, 45_000);
      const onData = (d: Buffer) => {
        text += d;
        if (!killed && /re-queuing for retry/.test(text)) {
          killed = true;
          child.kill("SIGTERM");
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, text }); });
    });
    assert.match(out.text, /#7 starting \(1\/1 slots in use\)/);
    assert.match(out.text, /#7 "t" claimed → sandbox/);
    assert.match(out.text, /#7 failed — re-queuing for retry \(1\/2\)/);
    assert.match(out.text, /SIGTERM received — interrupted/);
    assert.equal(out.code, 143, out.text);
    const calls = readFileSync(fx.calls, "utf8");
    assert.match(calls, /gh issue edit 7 --add-label agent:in-progress/);
    assert.match(calls, /gh issue edit 7 --remove-label ready-for-agent/);
    assert.match(calls, /git branch -D agent\/issue-7/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
