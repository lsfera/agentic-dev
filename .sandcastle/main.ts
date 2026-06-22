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
 *   AGENTIC_REPO          optional "owner/name" (default: cwd repo origin)
 *   AGENTIC_BASE_BRANCH   PR base branch (default: main)
 *   AGENTIC_MODEL         claudeCode model (default: claude-sonnet-4-6)
 *   SANDCASTLE_IMAGE      inner image (default: sandcastle:local)
 *   AGENTIC_CONCURRENCY   max parallel sandboxes (default: 1, serial)
 *
 * Concurrency note: raising AGENTIC_CONCURRENCY multiplies live resources —
 * N inner Docker sandboxes, N read-only SSH-key copies (ADR-0004), and
 * N concurrent Claude subscription seats. The safe default stays serial (1).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { reduce, READY_LABEL, type State, type Pr, type Policy, type Mode } from "./reduce.ts";
import { IssueSource } from "./issue-source.ts";
import { SandboxRunner, SANDBOX_LABEL } from "./sandbox-runner.ts";

export { SANDBOX_LABEL };

const sh = promisify(execFile);

/** Read the concurrency cap from AGENTIC_CONCURRENCY (default 1, serial). */
export function parseConcurrency(): number {
  return Math.max(1, Number(process.env.AGENTIC_CONCURRENCY ?? "1") || 1);
}

type ShellExec = (file: string, args: string[]) => Promise<{ stdout: string | Buffer }>;

/**
 * Remove all containers that carry the agentic sandbox label.
 *
 * Called on startup (sweeps orphans from a previous crashed run) and at the
 * end of main() (confirms no containers linger after a clean exit). Each
 * individual run() call already closes its sandbox in a finally block via
 * sandcastle's internal lifecycle management; this sweep is a belt-and-
 * suspenders backstop for the SIGKILL / OOM case where those hooks never fire.
 *
 * Accepts an optional exec shim for unit testing.
 */
export async function sweepOrphanedSandboxes(exec: ShellExec = sh as ShellExec): Promise<number> {
  try {
    const { stdout } = await exec("docker", [
      "ps", "-a", "-q", "--no-trunc",
      "--filter", `label=${SANDBOX_LABEL}`,
    ]);
    const ids = String(stdout)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return 0;
    await exec("docker", ["rm", "-f", ...ids]);
    console.log(`[afk] swept ${ids.length} orphaned sandbox container(s)`);
    return ids.length;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  // Startup sweep: remove orphaned containers from any previous crashed run.
  await sweepOrphanedSandboxes();

  const repo = process.env.AGENTIC_REPO;
  const base = process.env.AGENTIC_BASE_BRANCH ?? "main";
  const repoRoot = process.cwd();

  const issues = new IssueSource(repo);
  const tier = (process.env.AGENTIC_TIER ?? "claude") as "claude" | "local";
  const runner = new SandboxRunner({
    imageName: process.env.SANDCASTLE_IMAGE,
    model: process.env.AGENTIC_MODEL,
    tier,
    localModel: process.env.AGENTIC_LOCAL_MODEL,
    localImageName: process.env.SANDCASTLE_OPENCODE_IMAGE,
    cwd: repoRoot,
  });

  const inFlight: number[] = [];
  // Tracks the set of issue ids whose PRs have already been processed via
  // PrMerged to avoid re-emitting Relabel on every subsequent tick.
  const seenMerged = new Set<number>();

  const mode = (process.env.AGENTIC_MODE ?? "afk") as Mode;
  const policy: Policy = { concurrency: parseConcurrency(), mode };

  for (;;) {
    const mergedPrs = await issues.listMergedPrs();
    const openPrs = await issues.listOpenPrs();
    const allPrs = [...mergedPrs, ...openPrs];

    // Detect newly merged PRs and unblock dependent issues (#2).
    for (const pr of mergedPrs) {
      if (!seenMerged.has(pr.issue)) {
        seenMerged.add(pr.issue);
        const allIssues = await issues.listAll();
        const unblockState: State = {
          issues: allIssues,
          prs: allPrs,
          inFlight,
          policy,
        };
        const unblockActions = reduce(unblockState, { type: "PrMerged", pr });
        for (const action of unblockActions) {
          if (action.type === "Relabel") {
            console.log(`[${mode}] #${pr.issue} merged → relabelling #${action.issueId} as ${action.label}`);
            await issues.addLabel(action.issueId, action.label);
          }
        }
      }
    }

    const ready = await issues.listReady();
    const state: State = {
      issues: ready,
      prs: allPrs,
      inFlight,
      policy,
    };

    const actions = reduce(state, { type: "Tick" });

    if (actions.some((a) => a.type === "Stop")) {
      console.log(`[${mode}] nothing ready, nothing in flight — done.`);
      // Shutdown sweep: confirm no containers linger after a clean exit.
      await sweepOrphanedSandboxes();
      return;
    }

    const starts = actions.filter(
      (a): a is { type: "StartSandbox"; issueId: number } => a.type === "StartSandbox",
    );

    if (starts.length === 0) {
      // No sandbox to start this tick — either waiting for CI on open PRs or
      // all slots are occupied. Sleep briefly and poll again.
      console.log(`[${mode}] waiting for pending PRs or in-flight sandboxes...`);
      await new Promise<void>((r) => setTimeout(r, 60_000));
      continue;
    }

    // Launch every StartSandbox the reducer emitted this tick in parallel.
    // Each fires independently; inFlight is updated synchronously so the next
    // tick's reducer counts these as occupied slots and won't over-subscribe.
    for (const start of starts) {
      const n = start.issueId;
      inFlight.push(n);
      console.log(`[${mode}] #${n} starting (${inFlight.length}/${policy.concurrency} slots in use)`);

      void (async () => {
        let openedPr: Pr | null = null;
        try {
          openedPr = await processIssue(n, issues, runner, base, repoRoot, mode);
        } catch (err) {
          console.error(`[${mode}] #${n} failed:`, err);
          // Leave the issue claimed (label removed) for a human to inspect.
        } finally {
          inFlight.splice(inFlight.indexOf(n), 1);
        }

        if (openedPr) {
          const finishState: State = {
            issues: ready,
            prs: [...allPrs, openedPr],
            inFlight,
            policy,
          };
          const finishActions = reduce(finishState, { type: "SandboxFinished", issue: n, pr: openedPr });
          for (const action of finishActions) {
            if (action.type === "EnableAutoMerge") {
              console.log(`[${mode}] #${n} → enabling auto-merge`);
              try {
                await issues.enableAutoMerge(action.pr.issue);
              } catch (err) {
                // A config gap (auto-merge disabled, no required check) must not
                // crash the orchestrator — the PR stays open for a human to merge.
                console.error(`[${mode}] #${n} could not enable auto-merge:`, err);
              }
            }
            if (action.type === "WaitForHuman") {
              console.log(`[${mode}] #${n} → PR open, waiting for human review`);
            }
          }
        }
      })();
    }

    // Sleep before the next poll to avoid busy-waiting while sandboxes run.
    await new Promise<void>((r) => setTimeout(r, 60_000));
  }
}

async function processIssue(
  n: number,
  issues: IssueSource,
  runner: SandboxRunner,
  base: string,
  repoRoot: string,
  mode: Mode,
): Promise<Pr | null> {
  const issue = await issues.get(n);

  // Claim: drop the ready label so the next tick won't re-pick this issue.
  await issues.removeLabel(n, READY_LABEL);
  console.log(`[${mode}] #${n} "${issue.title}" claimed → sandbox`);

  const outcome = await runner.runIssue(issue);
  console.log(
    `[${mode}] #${n} sandbox done: branch=${outcome.branch} ` +
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
    return null;
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
  console.log(`[${mode}] #${n} → ${prUrl}`);
  return { issue: n, ciStatus: "pending", merged: false };
}

// Run only when executed directly; not when imported (e.g., in tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
