/**
 * IssueSource against a fake `gh` on PATH: verifies the Effect methods shape
 * gh output correctly and surface failures as typed GhError.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { IssueSource } from "./issue-source.ts";
import { GhError } from "./errors.ts";

let dir: string;
let origPath: string | undefined;

/** Install a fake `gh` that prints `stdout` (or exits 1 when `fail`). */
function fakeGh(stdout: string, fail = false) {
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh\n${fail ? 'echo "boom" >&2; exit 1' : `cat <<'EOF'\n${stdout}\nEOF`}\n`,
  );
  chmodSync(join(dir, "gh"), 0o755);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  origPath = process.env.PATH;
  process.env.PATH = `${dir}:${origPath}`;
});
after(() => {
  process.env.PATH = origPath;
  rmSync(dir, { recursive: true, force: true });
});

const run = <A>(eff: Effect.Effect<A, GhError>) => Effect.runPromise(eff);

test("listReady: maps gh JSON to reducer Issues with blockedBy parsed", async () => {
  fakeGh('[{"number":5,"labels":[{"name":"ready-for-agent"}],"body":"Blocked by #2"}]');
  assert.deepEqual(await run(new IssueSource().listReady()), [
    { id: 5, labels: ["ready-for-agent"], blockedBy: [2] },
  ]);
});

test("listOpenPrs: only agent/issue-N branches; CONFLICTING maps to 'conflicting'", async () => {
  fakeGh(
    '[{"number":1,"headRefName":"agent/issue-3","mergeable":"CONFLICTING"},' +
      '{"number":2,"headRefName":"agent/issue-4","mergeable":"MERGEABLE"},' +
      '{"number":3,"headRefName":"feature/x","mergeable":"MERGEABLE"}]',
  );
  assert.deepEqual(await run(new IssueSource().listOpenPrs()), [
    { issue: 3, ciStatus: "conflicting", merged: false },
    { issue: 4, ciStatus: "pending", merged: false },
  ]);
});

test("listMergedPrs: maps merged agent branches to success", async () => {
  fakeGh('[{"number":9,"headRefName":"agent/issue-7"}]');
  assert.deepEqual(await run(new IssueSource().listMergedPrs()), [
    { issue: 7, ciStatus: "success", merged: true },
  ]);
});

test("findIssueByLabel: none → null; several → lowest number", async () => {
  fakeGh("[]");
  assert.equal(await run(new IssueSource().findIssueByLabel("x")), null);
  fakeGh('[{"number":9},{"number":4},{"number":6}]');
  assert.deepEqual(await run(new IssueSource().findIssueByLabel("x")), { number: 4 });
});

test("createIssue: parses the issue number from the URL gh prints", async () => {
  fakeGh("https://github.com/o/r/issues/42");
  assert.equal(await run(new IssueSource().createIssue({ title: "t", body: "b", labels: ["l"] })), 42);
});

test("createIssue: unparseable gh output → GhError", async () => {
  fakeGh("not a url");
  const err = await Effect.runPromise(
    new IssueSource().createIssue({ title: "t", body: "b", labels: [] }).pipe(Effect.flip),
  );
  assert.ok(err instanceof GhError);
  assert.equal(err.op, "createIssue");
});

test("a failing gh call surfaces as a typed GhError carrying the op", async () => {
  fakeGh("", true);
  const err = await Effect.runPromise(new IssueSource().listAll().pipe(Effect.flip));
  assert.ok(err instanceof GhError);
  assert.equal(err._tag, "GhError");
  assert.equal(err.op, "listAll");
});

test("invalid JSON from gh is a GhError, not a thrown SyntaxError", async () => {
  fakeGh("{nope");
  const err = await Effect.runPromise(new IssueSource().listReady().pipe(Effect.flip));
  assert.equal(err._tag, "GhError");
});
