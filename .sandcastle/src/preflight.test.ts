import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { assessProtection, checkBranchProtection, protectionAction } from "./preflight.ts";

test("classic protection with contexts is ok", () => {
  const v = assessProtection({ classic: { required_status_checks: { contexts: ["ci"], checks: [] } }, rules: [] });
  assert.equal(v.ok, true);
});

test("classic protection with checks[] is ok", () => {
  assert.equal(assessProtection({ classic: { required_status_checks: { contexts: [], checks: [{ context: "ci" }] } }, rules: null }).ok, true);
});

test("protection without status checks fails", () => {
  const v = assessProtection({ classic: { required_status_checks: { contexts: [], checks: [] } }, rules: [] });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no required status checks/);
});

test("a ruleset with required_status_checks is ok", () => {
  assert.equal(assessProtection({ classic: null, rules: [{ type: "required_status_checks" }] }).ok, true);
});

test("unreadable protection fails with a distinct reason", () => {
  const v = assessProtection({ classic: null, rules: null });
  assert.equal(v.ok, false);
  assert.match(v.reason, /could not read/);
});

test("unprotected branch (classic 404, empty rules) fails", () => {
  assert.match(assessProtection({ classic: null, rules: [] }).reason, /no required status checks/);
});

test("protectionAction: warn by default, refuse when strict", () => {
  assert.equal(protectionAction({ ok: true, reason: "" }, true), "ok");
  assert.equal(protectionAction({ ok: false, reason: "" }, false), "warn");
  assert.equal(protectionAction({ ok: false, reason: "" }, true), "refuse");
});

test("checkBranchProtection queries both endpoints and tolerates gh failure", async () => {
  const calls: string[][] = [];
  const exec = (file: string, args: string[]) => {
    calls.push(args);
    if (args[1].includes("/protection")) return Promise.reject(new Error("404"));
    return Promise.resolve({ stdout: JSON.stringify([{ type: "required_status_checks" }]) });
  };
  const v = await Effect.runPromise(checkBranchProtection(exec, "main", "o/r"));
  assert.equal(v.ok, true);
  assert.deepEqual(calls.map((c) => c[1]), ["repos/o/r/branches/main/protection", "repos/o/r/rules/branches/main"]);
});
