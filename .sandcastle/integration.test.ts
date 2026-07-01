/**
 * Integration test — the secondary seam. Actually spins ONE sandcastle sandbox
 * against the path-matched mount and asserts a commit lands on the expected
 * branch. Guards the real round-trip (worktree resolves under DooD, the agent
 * commits via subscription auth). Hardened descendant of the ws/skeleton-spike
 * beat-1/beat-2 harness that proved ADR-0001/0003/0011.
 *
 * Slow / Docker-required, so it is excluded from the fast unit run (`npm test`)
 * and only runs under:  npm run test:integration
 *
 * Prereqs (inside the outer devcontainer, from the path-matched mount):
 *   - inner image built (sandcastle:local or $SANDCASTLE_IMAGE)
 *   - .sandcastle/.env with CLAUDE_CODE_OAUTH_TOKEN
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxRunner } from "./sandbox-runner.ts";
import { ReviewerAdapter } from "./reviewer-adapter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const enabled = !!process.env.SANDCASTLE_INTEGRATION;

// The repo root is the parent of this `.sandcastle/` dir. Anchor sandcastle's
// cwd here regardless of where the test runner is invoked from (npm runs it
// from `.sandcastle/`); the live orchestrator gets this for free by running
// from the repo root.
const repoRoot = resolve(import.meta.dirname, "..");

test(
  "sandbox round-trip: agent commits to agent/issue-<N>",
  { skip: enabled ? false : "set SANDCASTLE_INTEGRATION=1 (Docker required)" },
  async () => {
    const runner = new SandboxRunner({
      imageName: process.env.SANDCASTLE_IMAGE ?? "sandcastle:local",
      cwd: repoRoot,
      maxIterations: 4,
    });

    const outcome = await runner.runIssue({
      number: 999,
      title: "integration smoke",
      body:
        "Append exactly one line reading 'integration-smoke-ok' to README.md, " +
        "then commit it. Do not modify any other file.",
    });

    assert.equal(outcome.branch, "agent/issue-999");
    assert.ok(
      outcome.commits.length >= 1,
      `expected >=1 commit, got ${outcome.commits.length}`,
    );
    // The completion signal must fire — that is what stops the agent instead of
    // looping to the iteration cap and producing duplicate commits (issue #1:
    // "stops on the completion signal without duplicate commits"). A run that
    // hit the cap would have completed === false.
    assert.equal(
      outcome.completed,
      true,
      "agent should stop on the completion signal, not the iteration cap",
    );
    // Guard the single-line task against runaway duplicate commits.
    assert.ok(
      outcome.commits.length <= 2,
      `expected a tight commit count for a one-line change, got ${outcome.commits.length}`,
    );
  },
);

// ─── Reviewer gate integration test ────────────────────────────────────────

test(
  "review-gate: pass-2 extract round-trips to a non-null verdict",
  { skip: enabled ? false : "set SANDCASTLE_INTEGRATION=1 (Docker required)" },
  async () => {
    // Use the review-gate PR branch as the target — it has real code changes.
    const reviewer = new ReviewerAdapter({ cwd: repoRoot });
    const result = await reviewer.review({
      issueNumber: 82,
      issueTitle: "AI review gate non-functional: pass-2 extraction crashes",
      issueBody: "The AI review gate never produces a real verdict because the extraction pass crashes deterministically.",
      branch: "agent/issue-82-review-gate",
      prNumber: 85,
    });

    // A genuine pass should return the validated ReviewOutput (not null).
    // If the reviewer can't run on this branch (CI status block), skip gracefully.
    assert.ok(result != null, `expected non-null verdict from review-gate, got ${JSON.stringify(result)}`);
    assert.equal(result.verdict, "pass", `expected pass verdict, got ${result.verdict}`);
    assert.ok(result.summary.length > 0, "expected non-empty summary");
  },
);
