/**
 * Orchestrator entrypoint — the engine `/afk` launches (replacing the old
 * host-sub-agent loop). It runs INSIDE the outer devcontainer, from the
 * path-matched host mount (`${LOCAL_WORKSPACE_FOLDER}`), so sandcastle's
 * git-isolated worktrees resolve under docker-outside-of-docker (ADR-0011).
 *
 * Event-driven operation (ADR-0008): a smee.io SSE channel relays GitHub
 * pull_request webhooks into the orchestrator as PrMerged events. The poll
 * loop is kept as a reconciliation backstop (5 min interval when smee is
 * active) so a missed delivery cannot stall the run.
 *
 * Env:
 *   AGENTIC_REPO          optional "owner/name" (default: cwd repo origin)
 *   AGENTIC_BASE_BRANCH   PR base branch (default: main)
 *   AGENTIC_MODEL         claudeCode model (default: claude-sonnet-4-6)
 *   SANDCASTLE_IMAGE      inner image (default: sandcastle:local)
 *   SANDCASTLE_CONTAINER_UID  inner image's non-root UID (default: 1000, sandcastle's
 *                             own default — only needed when a custom image renames its
 *                             user to a different UID, e.g. the dotnet SDK base's 1654)
 *   SANDCASTLE_CONTAINER_GID  matching GID (default: 1000)
 *   SANDCASTLE_SKILLS_DIR     repo-relative dir of Claude skills to install into the inner
 *                             sandbox's ~/.claude/skills (ADR-0025)
 *   AGENTIC_REQUIRE_BRANCH_PROTECTION  =1 refuses /afk start when the base branch has no required
 *                             status checks (default: warn). AGENTIC_SKIP_PROTECTION_CHECK=1 disables.
 *   WEBHOOK_SIGNATURE_STRICT  =1 drops smee deliveries without a verified HMAC (default: advisory,
 *                             ADR-0008); the reconcile poll recovers genuine merges that are dropped.
 *   AGENTIC_CONCURRENCY   max parallel sandboxes (default: 1, serial)
 *   SMEE_URL              smee.io channel URL (enables event-driven mode)
 *   WEBHOOK_SECRET        shared HMAC secret for X-Hub-Signature-256 validation
 *
 * Concurrency note: raising AGENTIC_CONCURRENCY multiplies live resources —
 * N inner Docker sandboxes, N read-only SSH-key copies (ADR-0004), and
 * N concurrent Claude subscription seats. The safe default stays serial (1).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reduce, READY_LABEL, reviewVerdict, reconcileFromLabels, type State, type Pr, type Policy, type Mode, type ReviewOutput } from "./reduce.ts";
import { IssueSource } from "./issue-source.ts";
import { SandboxRunner, SANDBOX_LABEL, deriveProject } from "./sandbox-runner.ts";
import { ReviewerAdapter } from "./reviewer-adapter.ts";
import { readMemoryContextEffect, writeMemoryEntryEffect } from "./memory-store.ts";
import { parseMemoryTags, buildOutcomeEntry, type OutcomeAttempt } from "./memory.ts";
import { Effect, Fiber } from "effect";
import { GhError, ShellError, SandboxError } from "./errors.ts";
import { withRetry, retryEffect } from "./retry.ts";
export { withRetry };

export { SANDBOX_LABEL };

import {
  sh, causeOf, noteOf, orLog, ensureLifecycleLabels,
  resetAgentBranchEffect, refreshBaseEffect, sweepOrphanedSandboxesEffect, ensureSandboxNetworkEffect,
  SANDBOX_NETWORK,
  type ShellExec,
} from "./infra.ts";
import { startSmeeListener } from "./webhook.ts";
import { countPriorFailures, attemptFailedComment, exhaustedComment } from "./attempts.ts";
import { checkBranchProtection, protectionAction } from "./preflight.ts";
import { resolveRunMode, detachAndRelaunch, resolveDockerHost, parseConcurrency } from "./env.ts";

// Public, test-facing surface — implementations moved to env.ts / infra.ts / webhook.ts.
export {
  resetAgentBranchEffect, refreshBaseEffect, sweepOrphanedSandboxesEffect, ensureSandboxNetworkEffect,
  SANDBOX_NETWORK, SANDBOX_MTU,
  resetAgentBranch, refreshBase, sweepOrphanedSandboxes, ensureSandboxNetwork,
} from "./infra.ts";
export {
  validateSignatureEffect, validateSignature, classifyDeliveryEffect, classifyDelivery,
  parseSmeeEvent, shouldProcessDelivery, startSmeeListener, type SignatureVerdict, type SmeeEvent, type SmeeHandler,
} from "./webhook.ts";
export {
  parseOrchEnv, resolveDockerHost, resolveCredentials, resolveRunMode, parseConcurrency,
  type ResolvedCredentials,
} from "./env.ts";

// withRetry lives in retry.ts (shared with sandbox-runner.ts, which main.ts
// itself imports — keeping it there avoids a circular import). Imported and
// re-exported at the top of this file for existing consumers.

const main: Effect.Effect<void, GhError | ShellError> = Effect.gen(function* () {
  const mode = (process.env.AGENTIC_MODE ?? "afk") as Mode;

  if (resolveRunMode(process.env) === 'detached') {
    detachAndRelaunch(mode);
    return;
  }

  // Dodge the docker-outside-of-docker socat proxy (see resolveDockerHost): socat
  // breaks docker exec's streamed output, which sandcastle relies on for the agent
  // turn — without this every iteration is an empty turn. No-op when socat isn't in
  // play (bare `docker compose up`, or an explicit DOCKER_HOST). Must run before any
  // docker call below.
  const dockerHost = resolveDockerHost(
    process.env.DOCKER_HOST,
    existsSync("/var/run/docker-host.sock"),
  );
  if (dockerHost) process.env.DOCKER_HOST = dockerHost;

  const repo = process.env.AGENTIC_REPO;
  const base = process.env.AGENTIC_BASE_BRANCH ?? "main";
  const repoRoot = process.cwd();
  // Project identity scopes the orphan sweep so concurrent projects don't reap
  // each other's in-flight sandboxes (#40).
  const project = deriveProject(repo, repoRoot);

  // Startup sweep: remove this project's orphaned containers from any previous
  // crashed run.
  yield* sweepOrphanedSandboxesEffect(sh as ShellExec, project);

  // Ensure the durable lifecycle labels exist (ADR-0021). Best-effort — a failure
  // does not block the run; labels are only missing on first run or if deleted.
  yield* ensureLifecycleLabels(repo);

  // /afk auto-merges on green CI (ADR-0020), so CI must actually gate. Warn when
  // the base branch has no required status checks; refuse to start with
  // AGENTIC_REQUIRE_BRANCH_PROTECTION=1. /hitl has a human merge gate — skipped.
  if (mode === "afk" && process.env.AGENTIC_SKIP_PROTECTION_CHECK !== "1") {
    const verdict = yield* checkBranchProtection(sh as ShellExec, base, repo);
    const action = protectionAction(verdict, process.env.AGENTIC_REQUIRE_BRANCH_PROTECTION === "1");
    if (action !== "ok") {
      console.warn(
        `[afk] WARNING: ${verdict.reason} on '${base}'. Auto-merge would merge without a CI gate ` +
          `(ADR-0020). Require a status check via branch protection or a ruleset.`,
      );
    }
    if (action === "refuse") {
      console.error("[afk] refusing to start (AGENTIC_REQUIRE_BRANCH_PROTECTION=1).");
      process.exit(1);
    }
  }

  // Ensure the MTU-corrected sandbox network exists so the agent's streaming
  // responses don't stall on Docker Desktop's oversized default-bridge MTU (#48).
  const networkReady = yield* ensureSandboxNetworkEffect();
  const network = networkReady ? SANDBOX_NETWORK : undefined;

  const issues = new IssueSource(repo);
  const tier = (process.env.AGENTIC_TIER ?? "claude") as "claude" | "local";
  const containerUid = process.env.SANDCASTLE_CONTAINER_UID
    ? Number(process.env.SANDCASTLE_CONTAINER_UID)
    : undefined;
  const containerGid = process.env.SANDCASTLE_CONTAINER_GID
    ? Number(process.env.SANDCASTLE_CONTAINER_GID)
    : undefined;
  const runner = new SandboxRunner({
    imageName: process.env.SANDCASTLE_IMAGE,
    model: process.env.AGENTIC_MODEL,
    tier,
    localModel: process.env.AGENTIC_LOCAL_MODEL,
    localImageName: process.env.SANDCASTLE_OPENCODE_IMAGE,
    cwd: repoRoot,
    network,
    containerUid,
    containerGid,
    skillsDir: process.env.SANDCASTLE_SKILLS_DIR || undefined,
  });

  const reviewer = new ReviewerAdapter({
    model: process.env.AGENTIC_MODEL,
    cwd: repoRoot,
    baseBranch: base,
  });

  // In-process scheduling state. Plain mutable structures on purpose: the
  // reducer reads `inFlight` by reference, and the "check + add before the
  // first suspension" dedupe below relies on fibers running synchronously
  // until their first async step.
  const inFlight: number[] = [];
  // Per-issue count of SandboxFailed events dispatched this run. Persists
  // across ticks so the retry cap is enforced within a single orchestrator run.
  const failedAttempts: Record<number, number> = {};
  // Per-issue attempt history this run, accumulated across retries — flattened
  // into a single outcome memory entry at terminal state (ADR-0022).
  const attemptHistory: Record<number, OutcomeAttempt[]> = {};
  // Issue ids whose PrMerged event has been dispatched to the reducer.
  const seenMerges = new Set<number>();
  // GitHub X-GitHub-Delivery ids seen via smee — coarse delivery-level de-dupe.
  const seenDeliveries = new Set<string>();
  // Background fibers (per-issue workers, boot-time re-reviews). Awaited before
  // a clean exit so no in-progress work is cut short.
  const background = new Set<Fiber.Fiber<void, never>>();
  const track = (fiber: Fiber.Fiber<void, never>) => {
    background.add(fiber);
    fiber.addObserver(() => { background.delete(fiber); });
    return fiber;
  };

  const policy: Policy = { concurrency: parseConcurrency(), mode };

  /** gh call with the standard transient-failure backoff. */
  const gh = <A>(label: string, eff: Effect.Effect<A, GhError>) => retryEffect(eff, { label });
  const addLabel = (n: number, label: string) => gh(`addLabel #${n}`, issues.addLabel(n, label));

  // Dispatch a PrMerged event and execute the resulting Relabel actions.
  // Shared between the smee listener and the reconciliation poll; the
  // synchronous seenMerges check prevents double-dispatch.
  const handlePrMerged = (pr: Pr, source: string): Effect.Effect<void, GhError> =>
    Effect.gen(function* () {
      if (seenMerges.has(pr.issue)) return;
      seenMerges.add(pr.issue); // must stay before the first suspension

      console.log(`[${mode}] PR for #${pr.issue} merged (${source}) — checking dependents`);
      const allIssues = yield* gh("listAll", issues.listAll());
      const mergedPrsNow = yield* gh("listMergedPrs", issues.listMergedPrs());
      const openPrsNow = yield* gh("listOpenPrs", issues.listOpenPrs());
      const allPrsNow = [...mergedPrsNow, ...openPrsNow];

      const unblockState: State = { issues: allIssues, prs: allPrsNow, inFlight, policy };
      const unblockActions = reduce(unblockState, { type: "PrMerged", pr });
      for (const action of unblockActions) {
        if (action.type === "Relabel") {
          console.log(`[${mode}] #${pr.issue} merged → relabelling #${action.issueId} as ${action.label}`);
          yield* addLabel(action.issueId, action.label);
        }
      }
    });

  // Run the read-only AI review for #n's PR. Fail-safe: any reviewer or gh
  // failure → changes-requested, so a crash can never auto-merge.
  const reviewPr = (n: number, logPrefix: string) =>
    Effect.gen(function* () {
      const ghIssue = yield* issues.get(n);
      const diff = yield* issues.getPrDiff(n);
      return yield* reviewer.runReview(
        {
          issueNumber: n,
          issueTitle: ghIssue.title,
          issueBody: ghIssue.body,
          branch: `agent/issue-${n}`,
          prNumber: n,
        },
        diff,
      );
    }).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          console.warn(`${logPrefix} reviewer failed — defaulting to changes-requested:`, causeOf(err));
          return { verdict: reviewVerdict(null), output: null as ReviewOutput | null };
        }),
      ),
    );

  // Execute the reducer's follow-up actions for a finished review.
  const applyReviewActions = (
    actions: ReturnType<typeof reduce>,
    n: number,
    reviewOutput: ReviewOutput | null,
    logPrefix: string,
    onAutoMerge: Effect.Effect<void> = Effect.void,
  ) =>
    Effect.forEach(
      actions,
      (ra) => {
        switch (ra.type) {
          case "RemoveLabel":
            return issues.removeLabel(ra.issueId, ra.label).pipe(
              orLog(`${logPrefix} could not remove label ${ra.label}:`),
            );
          case "EnableAutoMerge":
            return Effect.sync(() => console.log(`${logPrefix} review passed → enabling auto-merge`)).pipe(
              Effect.andThen(issues.enableAutoMerge(ra.pr.issue).pipe(orLog(`${logPrefix} could not enable auto-merge:`))),
              // Terminal state (review passed — see ADR-0022 for why this,
              // not the later async PrMerged, is treated as the success point).
              Effect.andThen(onAutoMerge),
            );
          case "WaitForHuman":
            return Effect.sync(() => console.log(`${logPrefix} review requested changes → parked for human`)).pipe(
              Effect.andThen(
                reviewOutput
                  ? issues.postPrReview(n, reviewOutput).pipe(orLog(`${logPrefix} could not post PR review:`))
                  : Effect.void,
              ),
            );
          default:
            return Effect.void;
        }
      },
      { discard: true },
    );

  // Start the smee webhook listener if SMEE_URL is configured (ADR-0008).
  // The reconciliation poll below acts as the backstop for missed deliveries.
  const smeeUrl = process.env.SMEE_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;

  const signatureStrict = process.env.WEBHOOK_SIGNATURE_STRICT === "1";
  if (smeeUrl && signatureStrict && !webhookSecret) {
    console.warn("[smee] WEBHOOK_SIGNATURE_STRICT=1 but WEBHOOK_SECRET is unset — every delivery will be dropped; relying on the reconcile poll.");
  }
  if (smeeUrl && !signatureStrict) {
    console.warn("[smee] webhook signatures are advisory (the channel URL is the trust boundary). Set WEBHOOK_SIGNATURE_STRICT=1 to drop unverified deliveries; the reconcile poll covers any genuine ones lost.");
  }
  if (smeeUrl) {
    // The listener is a callback API; each delivery is run as its own fiber.
    startSmeeListener(smeeUrl, webhookSecret, async (body, headers, deliveryId) => {
      if (deliveryId && seenDeliveries.has(deliveryId)) return;
      if (deliveryId) seenDeliveries.add(deliveryId);

      if (headers["x-github-event"] !== "pull_request") return;

      type PrPayload = {
        action?: string;
        pull_request?: {
          merged?: boolean;
          head?: { ref?: string };
          merge_commit_sha?: string;
        };
      };
      const payload = body as PrPayload;
      if (payload.action !== "closed" || !payload.pull_request?.merged) return;

      const branch = payload.pull_request.head?.ref ?? "";
      const issueMatch = branch.match(/^agent\/issue-(\d+)$/);
      if (!issueMatch) return;

      const issueId = Number(issueMatch[1]);
      const mergeSha = payload.pull_request.merge_commit_sha ?? "";
      console.log(`[smee] PR merge: issue #${issueId} branch=${branch} sha=${mergeSha.slice(0, 7)}`);

      await Effect.runPromise(
        handlePrMerged({ issue: issueId, ciStatus: "success", merged: true }, `smee:${deliveryId}`).pipe(
          orLog(`[smee] handlePrMerged #${issueId} failed:`),
        ),
      );
    }, { strict: signatureStrict });
  }

  // With smee handling real-time merges, the poll loop is a reconciliation
  // backstop only; 5 min is sufficient. Without smee, keep the original 60s.
  const RECONCILE_INTERVAL = smeeUrl ? 5 * 60_000 : 60_000;

  // Boot reconcile (ADR-0021): read labels from a crashed predecessor and recover
  // in-flight work. Labels are written at each transition and read ONLY here at
  // startup; State.inFlight is the runtime source of truth thereafter.
  {
    const fetched = yield* Effect.all([
      gh("listAll (boot reconcile)", issues.listAll()),
      gh("listOpenPrs (boot reconcile)", issues.listOpenPrs()),
    ]).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          console.warn(`[${mode}] boot reconcile: could not fetch state — skipping:`, causeOf(err));
          return [[], []] as [import("./reduce.ts").Issue[], Pr[]];
        }),
      ),
    );
    const [bootIssues, bootOpenPrs] = fetched;
    const bootActions = reconcileFromLabels(bootIssues, bootOpenPrs);
    if (bootActions.length > 0) {
      console.log(`[${mode}] boot reconcile: ${bootActions.length} action(s) from crashed predecessor`);
    }
    for (const action of bootActions) {
      if (action.type === "RemoveLabel") {
        yield* issues.removeLabel(action.issueId, action.label).pipe(
          Effect.andThen(Effect.sync(() => console.log(`[${mode}] boot reconcile: #${action.issueId} removed label ${action.label}`))),
          orLog(`[${mode}] boot reconcile: could not remove label ${action.label} from #${action.issueId}:`),
        );
      }
      if (action.type === "Relabel") {
        yield* addLabel(action.issueId, action.label).pipe(
          Effect.andThen(Effect.sync(() => console.log(`[${mode}] boot reconcile: #${action.issueId} relabelled as ${action.label}`))),
          orLog(`[${mode}] boot reconcile: could not relabel #${action.issueId}:`),
        );
      }
      if (action.type === "StartReview") {
        // Re-run the read-only AI review on the existing PR (idempotent).
        // Runs in the background so startup is not blocked.
        const pr = action.pr;
        const n = pr.issue;
        const prefix = `[${mode}] boot reconcile: #${n}`;
        console.log(`${prefix} agent:in-review + open PR — re-running AI review`);
        const rereview = Effect.gen(function* () {
          const { verdict, output } = yield* reviewPr(n, prefix);
          console.log(`${prefix} review verdict: ${verdict}`);
          const reconcileState: State = { issues: bootIssues, prs: bootOpenPrs, inFlight, policy };
          const followUps = reduce(reconcileState, { type: "ReviewFinished", issue: n, pr, verdict });
          yield* applyReviewActions(followUps, n, output, prefix);
        });
        track(yield* Effect.forkChild(rereview));
      }
    }
  }

  // Everything one claimed issue goes through once its sandbox is launched:
  // run → record attempt → apply failure/finish transitions (+ AI review).
  const handleIssue = (
    n: number,
    snapshot: { ready: import("./reduce.ts").Issue[]; allPrs: Pr[] },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const result = yield* processIssue(n, issues, runner, base, repoRoot, mode).pipe(
        Effect.map((pr) =>
          pr === null
            ? ({ openedPr: null, failed: true, note: "sandbox produced no commits" } as const)
            : ({ openedPr: pr, failed: false, note: undefined } as const),
        ),
        Effect.tap((r) =>
          r.failed ? Effect.sync(() => console.log(`[${mode}] #${n} sandbox produced no commits`)) : Effect.void,
        ),
        Effect.catch((err) =>
          Effect.sync(() => {
            console.error(`[${mode}] #${n} failed:`, causeOf(err));
            return { openedPr: null, failed: true, note: noteOf(err) } as const;
          }),
        ),
        Effect.ensuring(Effect.sync(() => { inFlight.splice(inFlight.indexOf(n), 1); })),
      );
      const { openedPr, failed: sandboxFailed, note: failureNote } = result;
      const { ready, allPrs } = snapshot;

      // Record this attempt (ADR-0022) — flattened into a single outcome
      // memory entry when the issue reaches terminal state below.
      const history = attemptHistory[n] ?? (attemptHistory[n] = []);
      history.push({ succeeded: !sandboxFailed, note: sandboxFailed ? failureNote : undefined });

      if (sandboxFailed) {
        // Seed from the issue's own marker comments on first sight this run, so a
        // restart cannot reset the retry budget (cross-run persistence).
        if (!(n in failedAttempts)) {
          failedAttempts[n] = yield* issues.listComments(n).pipe(
            Effect.map(countPriorFailures),
            // Fail-open, including defects: an unreadable comment list must never
            // wedge the retry path (it just means "no prior failures known").
            Effect.catchCause(() => Effect.succeed(0)),
          );
        }
        const attempts = failedAttempts[n] ?? 0;
        const failState: State = { issues: ready, prs: allPrs, inFlight, policy, failedAttempts };
        const failActions = reduce(failState, { type: "SandboxFailed", issue: n });
        failedAttempts[n] = attempts + 1;
        for (const action of failActions) {
          if (action.type === "RemoveLabel") {
            yield* issues.removeLabel(action.issueId, action.label).pipe(
              orLog(`[${mode}] #${n} could not remove label ${action.label}:`),
            );
          }
          if (action.type === "Relabel") {
            console.log(
              `[${mode}] #${n} failed — re-queuing for retry ` +
                `(${attempts + 1}/${policy.maxRetries ?? 2})`,
            );
            yield* addLabel(n, action.label).pipe(orLog(`[${mode}] #${n} could not re-queue:`));
            yield* issues.comment(n, attemptFailedComment(attempts + 1, policy.maxRetries ?? 2)).pipe(
              orLog(`[${mode}] #${n} could not record attempt marker:`),
            );
          }
          if (action.type === "Comment") {
            console.log(`[${mode}] #${n} retries exhausted after ${attempts + 1} failures`);
            yield* issues.comment(n, exhaustedComment(action.body)).pipe(
              orLog(`[${mode}] #${n} could not post exhaustion comment:`),
            );
            // Terminal state (retries exhausted) — persist the outcome (ADR-0022).
            yield* writeMemoryEntryEffect(issues, buildOutcomeEntry({ issueNumber: n, attempts: history }));
          }
        }
      }

      if (openedPr) {
        const finishState: State = {
          issues: ready,
          prs: [...allPrs, openedPr],
          inFlight,
          policy,
        };
        const finishActions = reduce(finishState, { type: "SandboxFinished", issue: n, pr: openedPr });
        const prefix = `[${mode}] #${n}`;
        for (const action of finishActions) {
          if (action.type === "RemoveLabel") {
            yield* issues.removeLabel(action.issueId, action.label).pipe(
              orLog(`${prefix} could not remove label ${action.label}:`),
            );
          }
          if (action.type === "Relabel") {
            yield* addLabel(action.issueId, action.label).pipe(
              orLog(`${prefix} could not add label ${action.label}:`),
            );
          }
          if (action.type === "StartReview") {
            console.log(`${prefix} → running AI review`);
            const { verdict, output } = yield* reviewPr(n, prefix);
            console.log(`${prefix} review verdict: ${verdict}`);
            const reviewActions = reduce(finishState, {
              type: "ReviewFinished",
              issue: n,
              pr: action.pr,
              verdict,
            });
            yield* applyReviewActions(
              reviewActions,
              n,
              output,
              prefix,
              writeMemoryEntryEffect(
                issues,
                buildOutcomeEntry({ issueNumber: n, prNumber: openedPr.prNumber, attempts: history }),
              ),
            );
          }
          if (action.type === "WaitForHuman") {
            console.log(`${prefix} → PR open, waiting for human review`);
          }
        }
      }
    }).pipe(
      // A defect (bug) in one issue's handling must never take down the loop.
      Effect.catchCause((cause) =>
        Effect.sync(() => console.error(`[${mode}] #${n} handler crashed:`, cause)),
      ),
    );

  for (;;) {
    // Wrap all top-of-loop gh calls so a transient API blip causes a retry
    // rather than an unhandled failure that exits the process. If all retries
    // fail we log the error and sleep before the next tick.
    const poll = yield* Effect.gen(function* () {
      const mergedPrs = yield* gh("listMergedPrs", issues.listMergedPrs());
      const openPrs = yield* gh("listOpenPrs", issues.listOpenPrs());
      const allPrs = [...mergedPrs, ...openPrs];

      // Reconciliation backstop: process any merges the smee listener may have missed.
      for (const pr of mergedPrs) {
        yield* handlePrMerged(pr, "reconcile");
      }

      const ready = yield* gh("listReady", issues.listReady());
      return { ok: true, allPrs, ready } as const;
    }).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          console.error(`[${mode}] poll tick failed after retries — sleeping before next tick:`, causeOf(err));
          return { ok: false } as const;
        }),
      ),
    );
    if (!poll.ok) {
      yield* Effect.sleep(RECONCILE_INTERVAL);
      continue;
    }
    const { allPrs, ready } = poll;

    const state: State = {
      issues: ready,
      prs: allPrs,
      inFlight,
      policy,
    };

    const actions = reduce(state, { type: "Tick" });

    if (actions.some((a) => a.type === "Stop")) {
      console.log(`[${mode}] nothing ready, nothing in flight — done.`);
      // Let any background work (e.g. boot-time re-reviews) finish first.
      yield* Fiber.awaitAll([...background]);
      // Shutdown sweep: confirm no containers linger after a clean exit.
      yield* sweepOrphanedSandboxesEffect(sh as ShellExec, project);
      return;
    }

    const starts = actions.filter(
      (a): a is { type: "StartSandbox"; issueId: number } => a.type === "StartSandbox",
    );

    // Apply label transitions emitted by Tick (agent:in-progress for each claimed issue).
    // Executed before the sandboxes are forked so the label is durable immediately.
    for (const action of actions) {
      if (action.type === "Relabel") {
        yield* addLabel(action.issueId, action.label).pipe(
          orLog(`[${mode}] could not add label ${action.label} to #${action.issueId}:`),
        );
      }
    }

    if (starts.length === 0) {
      // No sandbox to start this tick — either waiting for CI on open PRs or
      // all slots are occupied. Sleep and poll again.
      console.log(`[${mode}] waiting for pending PRs or in-flight sandboxes...`);
      yield* Effect.sleep(RECONCILE_INTERVAL);
      continue;
    }

    // Launch every StartSandbox the reducer emitted this tick in parallel.
    // Each runs as its own fiber; inFlight is updated synchronously so the next
    // tick's reducer counts these as occupied slots and won't over-subscribe.
    for (const start of starts) {
      const n = start.issueId;
      inFlight.push(n);
      console.log(`[${mode}] #${n} starting (${inFlight.length}/${policy.concurrency} slots in use)`);
      track(yield* Effect.forkChild(handleIssue(n, { ready, allPrs })));
    }

    // Sleep before the next reconciliation poll.
    yield* Effect.sleep(RECONCILE_INTERVAL);
  }
});

const processIssue = (
  n: number,
  issues: IssueSource,
  runner: SandboxRunner,
  base: string,
  repoRoot: string,
  mode: Mode,
): Effect.Effect<(Pr & { prNumber?: number }) | null, GhError | ShellError | SandboxError> =>
  Effect.gen(function* () {
    const issue = yield* issues.get(n);

    // Claim: drop the ready label so the next tick won't re-pick this issue.
    yield* issues.removeLabel(n, READY_LABEL);
    console.log(`[${mode}] #${n} "${issue.title}" claimed → sandbox`);

    // Refresh the base branch from origin so the sandbox branch is cut from the
    // current origin/<base>, not a stale local HEAD that would conflict at merge
    // time (#28). Runs before resetAgentBranch so the recreated branch is based
    // on fresh origin.
    yield* refreshBaseEffect(base, (args) => sh("git", args, { cwd: repoRoot }));

    // Delete any stale agent/issue-N branch (local + remote) left by a prior
    // failed/partial run, so sandcastle branches from the current base instead
    // of reusing a stale ref that would conflict at merge time (#23).
    yield* resetAgentBranchEffect(n, (args) => sh("git", args, { cwd: repoRoot }));

    // Retrieve cross-run memory (ADR-0022) — repo conventions and gotchas
    // surfaced by previous runs against this repo. Fails open to "no memory"
    // internally; never blocks the sandbox from starting.
    const memoryContext = yield* readMemoryContextEffect(issues);

    const outcome = yield* runner.runIssue(issue, memoryContext);
    console.log(
      `[${mode}] #${n} sandbox done: branch=${outcome.branch} ` +
        `commits=${outcome.commits.length} completed=${outcome.completed}` +
        (outcome.logFilePath ? ` log=${outcome.logFilePath}` : ""),
    );

    // Optional agent-emitted enrichment (ADR-0022) — piggybacks on the same
    // stdout already scanned for the completion signal, no extra agent turn.
    for (const entry of parseMemoryTags(outcome.stdout)) {
      yield* writeMemoryEntryEffect(issues, entry);
    }

    if (outcome.commits.length === 0) {
      return null;
    }

    // Orchestrator-side push (over the devcontainer's mounted SSH key) + PR.
    yield* Effect.tryPromise({
      try: () => sh("git", ["push", "-u", "origin", outcome.branch], { cwd: repoRoot }),
      catch: (cause) => new ShellError({ command: `git push -u origin ${outcome.branch}`, cause }),
    });
    const shas = outcome.commits.map((c) => c.sha.slice(0, 7)).join(", ");
    const prUrl = yield* issues
      .openPr({
        head: outcome.branch,
        base,
        title: `#${n}: ${issue.title}`,
        body:
          `Closes #${n}\n\n` +
          `Implemented autonomously by the AFK orchestrator in an isolated, ` +
          `git-isolated sandbox.\n\nCommits: ${shas}`,
      })
      .pipe(
        // Branch is pushed but PR creation failed. Log the branch name so it can
        // be recovered manually with: gh pr create --head <branch>
        Effect.tapError((err) =>
          Effect.sync(() =>
            console.error(
              `[${mode}] #${n} gh pr create failed — branch ${outcome.branch} is pushed but has no PR:`,
              causeOf(err),
            ),
          ),
        ),
      );
    yield* issues.comment(n, `Implemented in an isolated sandbox; opened ${prUrl}.`);
    console.log(`[${mode}] #${n} → ${prUrl}`);
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    return {
      issue: n,
      ciStatus: "pending" as const,
      merged: false,
      prNumber: prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined,
    };
  });

// Run only when executed directly; not when imported (e.g., in tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Run as a root fiber so SIGINT/SIGTERM interrupt it: acquire/release
  // finalizers (sandbox close, worktree cleanup) then run instead of being
  // skipped by an abrupt process exit.
  const fiber = Effect.runFork(main);
  let signal: NodeJS.Signals | undefined;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      signal = sig;
      void Effect.runPromise(Fiber.interrupt(fiber));
    });
  }
  try {
    await Effect.runPromise(Fiber.join(fiber));
  } catch (err) {
    if (!signal) throw err;
    console.log(`[afk] ${signal} received — interrupted, resources released.`);
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}
