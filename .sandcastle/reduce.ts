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

export type CiStatus = "none" | "pending" | "success" | "failure";

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
}

export interface State {
  readonly issues: Issue[];
  readonly prs: Pr[];
  readonly policy: Policy;
  /** Issue ids whose sandbox is currently running. */
  readonly inFlight: number[];
}

export type Event =
  | { type: "Tick" }
  | { type: "PrMerged"; pr: Pr }
  | { type: "SandboxFinished"; issue: number; pr: Pr }
  | { type: "SandboxFailed"; issue: number };

export type Action =
  | { type: "StartSandbox"; issueId: number }
  | { type: "EnableAutoMerge"; pr: Pr }
  | { type: "Relabel"; issueId: number; label: string }
  | { type: "WaitForHuman"; pr: Pr }
  | { type: "Stop" };

export function reduce(state: State, event: Event): Action[] {
  switch (event.type) {
    case "Tick":
      return onTick(state);
    case "PrMerged":
      return onPrMerged(state, event.pr);
    // SandboxFinished / SandboxFailed land in later slices (#5).
    default:
      return [];
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

function onTick(state: State): Action[] {
  const ready = state.issues
    .filter((issue) => isReady(issue, state))
    .sort((a, b) => a.id - b.id);

  // Stop only when the world is quiet: nothing to start and nothing running.
  if (ready.length === 0 && state.inFlight.length === 0) {
    return [{ type: "Stop" }];
  }

  // Serial by default: never exceed the concurrency cap, counting in-flight work.
  const slots = Math.max(0, state.policy.concurrency - state.inFlight.length);
  return ready
    .slice(0, slots)
    .map((issue) => ({ type: "StartSandbox", issueId: issue.id }));
}
