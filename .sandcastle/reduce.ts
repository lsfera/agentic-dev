/**
 * Pure orchestration core — the primary test seam.
 *
 * `reduce(state, event) -> Action[]` holds ALL decision logic and performs NO
 * I/O: given a snapshot of the world and one event, it returns the set of
 * actions to take. Adapters (issue-source, sandbox-runner) carry out actions
 * and feed events back in; they make no decisions themselves.
 *
 * Slice 1 (walking skeleton, issue #1) scope only:
 *   - compute the ready-set (labelled, not in flight, no PR yet)
 *   - start ready issues up to the serial concurrency cap
 *   - Stop cleanly when nothing is ready and nothing is in flight
 *
 * Later slices extend this reducer in place:
 *   #2 dependency unblocking (blockedBy + merged PRs)
 *   #3 EnableAutoMerge / #4 WaitForHuman (merge gating by policy.mode)
 *   #5 PrMerged events + dedupe + "in flight keeps us listening"
 *   #6 concurrency > 1
 * The type surface below already names those actions/events so the shape is
 * stable; only Tick is interpreted in this slice.
 */

export const READY_LABEL = "ready-for-agent";
export const IN_PROGRESS_LABEL = "agent:in-progress";
export const IN_REVIEW_LABEL = "agent:in-review";

export type CiStatus = "none" | "pending" | "success" | "failure" | "conflicting";

export type ReviewVerdict = "pass" | "changes-requested";

export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface ReviewOutput {
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly comments: ReadonlyArray<ReviewComment>;
}

export interface Issue {
  readonly id: number;
  readonly labels: string[];
  /** Issue ids that must have a merged PR before this one is workable (#2). */
  readonly blockedBy: number[];
}

export interface Pr {
  readonly issue: number;
  readonly ciStatus: CiStatus;
  readonly merged: boolean;
}

export type Mode = "afk" | "hitl";

export interface Policy {
  readonly concurrency: number;
  readonly mode: Mode;
  /** Maximum retries per issue within a single orchestrator run (default 2). */
  readonly maxRetries?: number;
}

export interface State {
  readonly issues: Issue[];
  readonly prs: Pr[];
  readonly policy: Policy;
  /** Issue ids whose sandbox is currently running. */
  readonly inFlight: number[];
  /** Per-issue count of SandboxFailed events dispatched this run (default {}). */
  readonly failedAttempts?: Record<number, number>;
}

export type Event =
  | { type: "Tick" }
  | { type: "PrMerged"; pr: Pr }
  | { type: "SandboxFinished"; issue: number; pr: Pr }
  | { type: "SandboxFailed"; issue: number }
  | { type: "ReviewFinished"; issue: number; pr: Pr; verdict: ReviewVerdict };

export type Action =
  | { type: "StartSandbox"; issueId: number }
  | { type: "StartReview"; pr: Pr }
  | { type: "EnableAutoMerge"; pr: Pr }
  | { type: "Relabel"; issueId: number; label: string }
  | { type: "RemoveLabel"; issueId: number; label: string }
  | { type: "WaitForHuman"; pr: Pr }
  | { type: "Comment"; issueId: number; body: string }
  | { type: "Stop" };

export function reduce(state: State, event: Event): Action[] {
  switch (event.type) {
    case "Tick":
      return onTick(state);
    case "PrMerged":
      return onPrMerged(state, event.pr);
    case "SandboxFinished":
      return onSandboxFinished(state, event);
    case "ReviewFinished":
      return onReviewFinished(event);
    case "SandboxFailed":
      return onSandboxFailed(state, event);
  }
}

/** An issue is workable when it carries the ready label, has no sandbox
 *  running, has no PR open yet, and every blocker has a merged PR. */
function isReady(issue: Issue, state: State): boolean {
  const mergedIds = new Set(
    state.prs.filter((pr) => pr.merged).map((pr) => pr.issue),
  );
  return (
    issue.labels.includes(READY_LABEL) &&
    !state.inFlight.includes(issue.id) &&
    !state.prs.some((pr) => pr.issue === issue.id) &&
    issue.blockedBy.every((id) => mergedIds.has(id))
  );
}

/** When a PR merges, emit Relabel for any issue whose every blocker is now
 *  merged — including the one that just merged. The orchestrator executes the
 *  Relabel so the next Tick picks the issue up as ready. */
function onPrMerged(state: State, mergedPr: Pr): Action[] {
  const mergedIds = new Set(
    state.prs.filter((pr) => pr.merged).map((pr) => pr.issue),
  );
  mergedIds.add(mergedPr.issue);

  return state.issues
    .filter(
      (issue) =>
        issue.blockedBy.includes(mergedPr.issue) &&
        issue.blockedBy.every((id) => mergedIds.has(id)),
    )
    .map((issue) => ({ type: "Relabel", issueId: issue.id, label: READY_LABEL }));
}

function onSandboxFinished(state: State, event: { issue: number; pr: Pr }): Action[] {
  if (state.policy.mode === "afk") {
    return [
      { type: "StartReview", pr: event.pr },
      { type: "RemoveLabel", issueId: event.issue, label: IN_PROGRESS_LABEL },
      { type: "Relabel", issueId: event.issue, label: IN_REVIEW_LABEL },
    ];
  }
  return [
    { type: "WaitForHuman", pr: event.pr },
    { type: "RemoveLabel", issueId: event.issue, label: IN_PROGRESS_LABEL },
  ];
}

function onReviewFinished(event: { issue: number; pr: Pr; verdict: ReviewVerdict }): Action[] {
  if (event.verdict === "pass") {
    return [
      { type: "EnableAutoMerge", pr: event.pr },
      { type: "RemoveLabel", issueId: event.issue, label: IN_REVIEW_LABEL },
    ];
  }
  return [
    { type: "WaitForHuman", pr: event.pr },
    { type: "RemoveLabel", issueId: event.issue, label: IN_REVIEW_LABEL },
  ];
}

function onSandboxFailed(state: State, event: { issue: number }): Action[] {
  const maxRetries = state.policy.maxRetries ?? 2;
  const attempts = (state.failedAttempts ?? {})[event.issue] ?? 0;
  if (attempts < maxRetries) {
    return [
      { type: "RemoveLabel", issueId: event.issue, label: IN_PROGRESS_LABEL },
      { type: "Relabel", issueId: event.issue, label: READY_LABEL },
    ];
  }
  return [
    { type: "RemoveLabel", issueId: event.issue, label: IN_PROGRESS_LABEL },
    {
      type: "Comment",
      issueId: event.issue,
      body:
        `AFK agent failed ${attempts + 1} times (retry limit: ${maxRetries}) — ` +
        `leaving this issue unlabelled for a human to inspect and re-label ` +
        `\`ready-for-agent\` if appropriate.`,
    },
  ];
}

/**
 * Map a structured review output (or any extraction/validation error) to a
 * merge verdict. Fail-safe: any missing or malformed result → "changes-requested"
 * so a reviewer crash never silently auto-merges.
 */
export function reviewVerdict(result: ReviewOutput | Error | null | undefined): ReviewVerdict {
  if (!result || result instanceof Error) return "changes-requested";
  const v = (result as ReviewOutput).verdict;
  if (v === "pass" || v === "changes-requested") return v;
  return "changes-requested";
}

function onTick(state: State): Action[] {
  const ready = state.issues
    .filter((issue) => isReady(issue, state))
    .sort((a, b) => a.id - b.id);

  // Open PRs keep the loop alive: in afk mode we wait for CI + auto-merge; in
  // hitl mode we wait for the human to act. Exception: a conflicting PR can
  // never auto-merge — exclude it so the loop doesn't hang forever (#23).
  const pendingMerge = state.prs.some((pr) => !pr.merged && pr.ciStatus !== "conflicting");

  // Stop only when the world is quiet: nothing to start, nothing running, and
  // no PRs awaiting merge.
  if (ready.length === 0 && state.inFlight.length === 0 && !pendingMerge) {
    return [{ type: "Stop" }];
  }

  // Serial by default: never exceed the concurrency cap, counting in-flight work.
  const slots = Math.max(0, state.policy.concurrency - state.inFlight.length);
  const toStart = ready.slice(0, slots);
  // Emit StartSandbox then Relabel(agent:in-progress) for each claimed issue.
  // The label is the durable mirror written at claim time (ADR-0021).
  return [
    ...toStart.map((issue): Action => ({ type: "StartSandbox", issueId: issue.id })),
    ...toStart.map((issue): Action => ({ type: "Relabel", issueId: issue.id, label: IN_PROGRESS_LABEL })),
  ];
}

/**
 * Startup reconcile: pure function over the boot-time label snapshot → actions.
 *
 * Reads labels written by a previous orchestrator run to recover work that was
 * in-flight when it crashed. Called once at startup; State.inFlight is the
 * runtime source of truth thereafter (ADR-0021).
 *
 * - agent:in-progress (no open PR) → re-queue to ready-for-agent (fresh sandbox).
 * - agent:in-review (open PR) → re-run the read-only AI review on the PR.
 * - agent:in-review (no PR, e.g. merged/closed) → remove stale label.
 * - agent:in-progress (open PR exists) → leave for normal flow; unusual state.
 */
export function reconcileFromLabels(issues: Issue[], prs: Pr[]): Action[] {
  const openPrByIssue = new Map<number, Pr>(
    prs.filter((p) => !p.merged).map((p) => [p.issue, p]),
  );
  const actions: Action[] = [];

  for (const issue of issues) {
    if (issue.labels.includes(IN_PROGRESS_LABEL) && !openPrByIssue.has(issue.id)) {
      // Sandbox was running but no PR opened — re-queue for a fresh attempt.
      actions.push({ type: "RemoveLabel", issueId: issue.id, label: IN_PROGRESS_LABEL });
      actions.push({ type: "Relabel", issueId: issue.id, label: READY_LABEL });
    }

    if (issue.labels.includes(IN_REVIEW_LABEL)) {
      const pr = openPrByIssue.get(issue.id);
      if (pr) {
        // AI review was running — re-run it on the existing PR (idempotent).
        // The label is removed when ReviewFinished is processed.
        actions.push({ type: "StartReview", pr });
      } else {
        // PR gone (merged/closed) — clean up the stale label.
        actions.push({ type: "RemoveLabel", issueId: issue.id, label: IN_REVIEW_LABEL });
      }
    }
  }

  return actions;
}
