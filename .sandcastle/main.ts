/**
 * Orchestrator entrypoint — the engine `/afk` launches (replacing the old
 * host-sub-agent loop). It runs INSIDE the outer devcontainer, from the
 * path-matched host mount (`${LOCAL_WORKSPACE_FOLDER}`), so sandcastle's
 * git-isolated worktrees resolve under docker-outside-of-docker (ADR-0011).
 *
 * Slice 1 (walking skeleton) is a serial poll loop:
 *   tick -> reduce(state, Tick) -> StartSandbox(id) | Stop
 *   on StartSandbox: claim the issue, run one sandbox, push its branch, open a PR
 *   stop when nothing is ready and nothing is in flight
 *
 * Event-driven operation (smee), auto-merge, HITL, dependency unblocking, and
 * concurrency > 1 arrive in later slices; the decision logic for them lives in
 * the pure reducer, not here.
 *
 * Env:
 *   AGENTIC_REPO         optional "owner/name" (default: cwd repo origin)
 *   AGENTIC_BASE_BRANCH  PR base branch (default: main)
 *   AGENTIC_MODEL        claudeCode model (default: claude-sonnet-4-6)
 *   SANDCASTLE_IMAGE     inner image (default: sandcastle:local)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { reduce, READY_LABEL, type State } from "./reduce.ts";
import { IssueSource } from "./issue-source.ts";
import { SandboxRunner } from "./sandbox-runner.ts";

const sh = promisify(execFile);

async function main(): Promise<void> {
  const repo = process.env.AGENTIC_REPO;
  const base = process.env.AGENTIC_BASE_BRANCH ?? "main";
  const repoRoot = process.cwd();

  const issues = new IssueSource(repo);
  const runner = new SandboxRunner({
    imageName: process.env.SANDCASTLE_IMAGE ?? "sandcastle:local",
    model: process.env.AGENTIC_MODEL,
    cwd: repoRoot,
  });

  const inFlight: number[] = [];

  for (;;) {
    const ready = await issues.listReady();
    const state: State = {
      issues: ready,
      prs: [], // slice 1 does not yet track open PRs in state (#5)
      inFlight,
      policy: { concurrency: 1, mode: "afk" },
    };

    const actions = reduce(state, { type: "Tick" });

    if (actions.some((a) => a.type === "Stop")) {
      console.log("[afk] nothing ready, nothing in flight — done.");
      return;
    }

    const start = actions.find((a) => a.type === "StartSandbox");
    if (!start || start.type !== "StartSandbox") {
      // No slot free this tick (shouldn't happen in serial slice 1); bail safe.
      console.log("[afk] no startable work this tick — done.");
      return;
    }

    const n = start.issueId;
    inFlight.push(n);
    try {
      await processIssue(n, issues, runner, base, repoRoot);
    } catch (err) {
      console.error(`[afk] #${n} failed:`, err);
      // Leave the issue claimed (label removed) for a human to inspect.
    } finally {
      inFlight.splice(inFlight.indexOf(n), 1);
    }
  }
}

async function processIssue(
  n: number,
  issues: IssueSource,
  runner: SandboxRunner,
  base: string,
  repoRoot: string,
): Promise<void> {
  const issue = await issues.get(n);

  // Claim: drop the ready label so the next tick won't re-pick this issue.
  await issues.removeLabel(n, READY_LABEL);
  console.log(`[afk] #${n} "${issue.title}" claimed → sandbox`);

  const outcome = await runner.runIssue(issue);
  console.log(
    `[afk] #${n} sandbox done: branch=${outcome.branch} ` +
      `commits=${outcome.commits.length} completed=${outcome.completed}` +
      (outcome.logFilePath ? ` log=${outcome.logFilePath}` : ""),
  );

  if (outcome.commits.length === 0) {
    // Leave the issue claimed (label stays off) so the poll loop does not
    // re-pick a persistently-failing issue every tick. A human re-labels it
    // after inspecting. (Automated backoff/retry is later work, not slice 1.)
    await issues.comment(
      n,
      "AFK agent produced no commits — leaving this issue unlabelled for a " +
        "human to inspect and re-label `ready-for-agent` if appropriate.",
    );
    return;
  }

  // Orchestrator-side push (over the devcontainer's mounted SSH key) + PR.
  await sh("git", ["push", "-u", "origin", outcome.branch], { cwd: repoRoot });
  const shas = outcome.commits.map((c) => c.sha.slice(0, 7)).join(", ");
  const prUrl = await issues.openPr({
    head: outcome.branch,
    base,
    title: `#${n}: ${issue.title}`,
    body:
      `Closes #${n}\n\n` +
      `Implemented autonomously by the AFK orchestrator in an isolated, ` +
      `git-isolated sandbox.\n\nCommits: ${shas}`,
  });
  await issues.comment(n, `Implemented in an isolated sandbox; opened ${prUrl}.`);
  console.log(`[afk] #${n} → ${prUrl}`);
}

await main();
