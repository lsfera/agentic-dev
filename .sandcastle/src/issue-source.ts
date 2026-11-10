/**
 * IssueSource — the GitHub adapter. Thin wrapper over the `gh` CLI: list ready
 * issues, read one, claim/relabel, comment, and open a PR. No decision logic
 * lives here (that is the reducer's job); this only carries out actions and
 * shapes GitHub state into the reducer's `Issue` type.
 *
 * Runs inside the outer devcontainer, where `gh` is already authenticated.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { GhError } from "./errors.ts";
import { READY_LABEL, type Issue, type Pr, type CiStatus, type ReviewOutput } from "./reduce.ts";

const exec = promisify(execFile);

/**
 * Render a structured review verdict as plain markdown, for postPrReview's
 * final fallback (a plain PR comment) when GitHub's formal review API is
 * unavailable (self-review restriction — see postPrReview).
 */
export function formatReviewAsComment(output: ReviewOutput): string {
  const header = `**AI review: ${output.verdict}**\n\n${output.summary}`;
  if (output.comments.length === 0) return header;
  const commentsBlock = output.comments
    .map((c) => `**${c.path}:${c.line}** — ${c.body}`)
    .join("\n\n");
  return `${header}\n\n---\n${commentsBlock}`;
}

/** Parse "Blocked by #N" references from an issue body (one or many). */
export function parseBlockedBy(body: string): number[] {
  const idx = body.search(/blocked\s+by\b/i);
  if (idx < 0) return [];
  const rest = body.slice(idx);
  // Stop at the next markdown section header, if any.
  const end = rest.search(/\n##/);
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(/#(\d+)/g)].map((m) => parseInt(m[1], 10));
}

export interface GhIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: { name: string }[];
}

export class IssueSource {
  /** @param repo optional "owner/name"; omit to use the cwd repo's origin. */
  constructor(private readonly repo?: string) {}

  private fullArgs(args: string[]): string[] {
    return this.repo ? ["-R", this.repo, ...args] : args;
  }

  /** Run `gh`, failing with a typed GhError. `op` names the call for diagnostics. */
  private gh(op: string, args: string[]): Effect.Effect<{ stdout: string }, GhError> {
    return Effect.tryPromise({
      try: () => exec("gh", this.fullArgs(args), { maxBuffer: 16 * 1024 * 1024 }),
      catch: (cause) => new GhError({ op, cause }),
    });
  }

  /** `gh` with a JSON stdout payload, parsed (a parse failure is a GhError too). */
  private ghJson<T>(op: string, args: string[]): Effect.Effect<T, GhError> {
    return this.gh(op, args).pipe(
      Effect.flatMap(({ stdout }) =>
        Effect.try({
          try: () => JSON.parse(stdout) as T,
          catch: (cause) => new GhError({ op, cause }),
        }),
      ),
    );
  }

  private ghWithInput(op: string, args: string[], input: string): Effect.Effect<{ stdout: string }, GhError> {
    return Effect.callback<{ stdout: string }, GhError>((resume) => {
      const child = spawn("gh", this.fullArgs(args), { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("close", (code: number | null) => {
        if (code !== 0) resume(Effect.fail(new GhError({ op, cause: new Error(`gh exited ${code}: ${stderr}`) })));
        else resume(Effect.succeed({ stdout }));
      });
      child.on("error", (cause) => resume(Effect.fail(new GhError({ op, cause }))));
      child.stdin.write(input);
      child.stdin.end();
      return Effect.sync(() => { child.kill(); });
    });
  }

  /** Open issues carrying the ready label, with dependency refs parsed from body. */
  listReady(): Effect.Effect<Issue[], GhError> {
    return this.ghJson<RawIssue[]>("listReady", [
      "issue", "list",
      "--state", "open",
      "--label", READY_LABEL,
      "--json", "number,labels,body",
    ]).pipe(Effect.map(toIssues));
  }

  /** All open issues (regardless of label), with dependency refs parsed. */
  listAll(): Effect.Effect<Issue[], GhError> {
    return this.ghJson<RawIssue[]>("listAll", [
      "issue", "list",
      "--state", "open",
      "--json", "number,labels,body",
    ]).pipe(Effect.map(toIssues));
  }

  /** Merged PRs opened from `agent/issue-N` branches, mapped back to issue ids. */
  listMergedPrs(): Effect.Effect<Pr[], GhError> {
    return this.ghJson<{ number: number; headRefName: string }[]>("listMergedPrs", [
      "pr", "list",
      "--state", "merged",
      "--json", "number,headRefName",
    ]).pipe(
      Effect.map((raw) =>
        raw.flatMap((pr): Pr[] => {
          const m = pr.headRefName.match(/issue-(\d+)$/);
          return m ? [{ issue: parseInt(m[1], 10), ciStatus: "success" as CiStatus, merged: true }] : [];
        }),
      ),
    );
  }

  /** Open PRs from `agent/issue-N` branches, mapped back to issue ids. */
  listOpenPrs(): Effect.Effect<Pr[], GhError> {
    return this.ghJson<{ number: number; headRefName: string; mergeable: string }[]>("listOpenPrs", [
      "pr", "list",
      "--state", "open",
      "--json", "number,headRefName,mergeable",
    ]).pipe(
      Effect.map((raw) =>
        raw.flatMap((pr): Pr[] => {
          const m = pr.headRefName.match(/issue-(\d+)$/);
          if (!m) return [];
          // A CONFLICTING PR can never auto-merge; mark it so the reducer does
          // not keep the loop alive forever waiting on it (#23).
          const ciStatus: CiStatus = pr.mergeable === "CONFLICTING" ? "conflicting" : "pending";
          return [{ issue: parseInt(m[1], 10), ciStatus, merged: false }];
        }),
      ),
    );
  }

  /** Enable GitHub-native auto-merge on the PR for the given issue. */
  enableAutoMerge(issueId: number): Effect.Effect<void, GhError> {
    return this.gh("enableAutoMerge", ["pr", "merge", `agent/issue-${issueId}`, "--auto", "--squash"]).pipe(Effect.asVoid);
  }

  get(n: number): Effect.Effect<GhIssue, GhError> {
    return this.ghJson<GhIssue>("get", ["issue", "view", String(n), "--json", "number,title,body,labels"]);
  }

  removeLabel(n: number, label: string): Effect.Effect<void, GhError> {
    return this.gh("removeLabel", ["issue", "edit", String(n), "--remove-label", label]).pipe(Effect.asVoid);
  }

  addLabel(n: number, label: string): Effect.Effect<void, GhError> {
    return this.gh("addLabel", ["issue", "edit", String(n), "--add-label", label]).pipe(Effect.asVoid);
  }

  comment(n: number, body: string): Effect.Effect<void, GhError> {
    return this.gh("comment", ["issue", "comment", String(n), "--body", body]).pipe(Effect.asVoid);
  }

  /**
   * Find the open issue carrying `label`, or null if none exists. Used for
   * label-discovered singleton issues (e.g. the pinned memory issue, #22).
   * If a create-race ever produces more than one, the lowest-numbered issue
   * is treated as canonical and the duplicate is left for a human to close —
   * detect-and-converge rather than locking (ADR-0022).
   */
  findIssueByLabel(label: string): Effect.Effect<{ number: number } | null, GhError> {
    return this.ghJson<{ number: number }[]>("findIssueByLabel", [
      "issue", "list",
      "--state", "open",
      "--label", label,
      "--json", "number",
      "--limit", "50",
    ]).pipe(
      Effect.map((raw) => {
        if (raw.length === 0) return null;
        const number = Math.min(...raw.map((r) => r.number));
        if (raw.length > 1) {
          console.warn(
            `[issue-source] multiple open issues carry label '${label}' — using the oldest (#${number})`,
          );
        }
        return { number };
      }),
    );
  }

  /**
   * Ensure a label exists so `--label X` on issue create/edit doesn't fail
   * with "not found" — `gh issue create` never auto-creates labels itself.
   * Idempotent (`--force`); best-effort — a failure here is swallowed and
   * left for the caller's own `--label` flag to surface as a real error.
   */
  private ensureLabel(label: string): Effect.Effect<void> {
    return this.gh("ensureLabel", ["label", "create", label, "--force"]).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    );
  }

  /** Create a new issue with the given labels. Returns the new issue number. */
  createIssue(opts: { title: string; body: string; labels: string[] }): Effect.Effect<number, GhError> {
    return Effect.forEach(opts.labels, (label) => this.ensureLabel(label), { concurrency: "unbounded" }).pipe(
      Effect.andThen(
        this.gh("createIssue", [
          "issue", "create",
          "--title", opts.title,
          "--body", opts.body,
          ...opts.labels.flatMap((label) => ["--label", label]),
        ]),
      ),
      Effect.flatMap(({ stdout }) => {
        const url = stdout.trim();
        const match = url.match(/\/issues\/(\d+)/);
        return match
          ? Effect.succeed(parseInt(match[1], 10))
          : Effect.fail(new GhError({ op: "createIssue", cause: new Error(`could not parse issue number from gh output: ${url}`) }));
      }),
    );
  }

  /** All comment bodies on an issue, oldest first (as GitHub returns them). */
  listComments(n: number): Effect.Effect<string[], GhError> {
    return this.ghJson<{ comments: { body: string }[] }>("listComments", ["issue", "view", String(n), "--json", "comments"]).pipe(
      Effect.map((raw) => raw.comments.map((c) => c.body)),
    );
  }

  /** Return the unified diff for the PR on the given issue's branch. */
  getPrDiff(issueId: number): Effect.Effect<string, GhError> {
    return this.gh("getPrDiff", ["pr", "diff", `agent/issue-${issueId}`]).pipe(Effect.map((r) => r.stdout));
  }

  /**
   * Post a REQUEST_CHANGES review on the PR for the given issue.
   * Uses the GitHub API to attach the structured verdict + filtered inline comments.
   * Best-effort, two-stage fallback:
   *   1. inline comments may fail when lines are no longer in the diff — retry
   *      as a plain top-level review (no inline comments).
   *   2. GitHub rejects REQUEST_CHANGES reviews from a PR's OWN AUTHOR
   *      ("Review Can not request changes on your own pull request", HTTP 422)
   *      — the normal case here, since this orchestrator's GH_TOKEN both opens
   *      the PR and posts its AI review. A plain PR comment carries the same
   *      feedback without that restriction, so it is the final fallback rather
   *      than letting the verdict go unposted (confirmed live: both the inline
   *      and body-only review attempts hit the identical 422 in that case).
   */
  postPrReview(issueId: number, output: ReviewOutput): Effect.Effect<void, GhError> {
    const self = this;
    return Effect.gen(function* () {
      const prInfo = yield* self.ghJson<{ number: number; headRefOid: string }>("postPrReview", [
        "pr", "view", `agent/issue-${issueId}`,
        "--json", "number,headRefOid",
      ]);

      const reviewBody = {
        commit_id: prInfo.headRefOid,
        event: "REQUEST_CHANGES",
        body: output.summary,
        comments: output.comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: "RIGHT",
          body: c.body,
        })),
      };
      const post = (body: unknown) =>
        self.ghWithInput(
          "postPrReview",
          ["api", `repos/{owner}/{repo}/pulls/${prInfo.number}/reviews`, "--method", "POST", "--input", "-"],
          JSON.stringify(body),
        );

      const inline = yield* post(reviewBody).pipe(
        Effect.as(true),
        Effect.catch((err) =>
          Effect.sync(() => {
            console.warn(`[issue-source] inline review post failed — falling back to body-only review:`, err.cause);
            return false;
          }),
        ),
      );
      if (inline) return;

      const bodyOnly = yield* post({ ...reviewBody, comments: [] }).pipe(
        Effect.as(true),
        Effect.catch((err) =>
          Effect.sync(() => {
            console.warn(`[issue-source] body-only review post also failed — falling back to a plain PR comment:`, err.cause);
            return false;
          }),
        ),
      );
      if (bodyOnly) return;

      yield* self.comment(issueId, formatReviewAsComment(output));
    });
  }

  /** Open a PR for an already-pushed head branch. Returns the PR URL. */
  openPr(opts: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Effect.Effect<string, GhError> {
    return this.gh("openPr", [
      "pr", "create",
      "--head", opts.head,
      "--base", opts.base,
      "--title", opts.title,
      "--body", opts.body,
    ]).pipe(Effect.map((r) => r.stdout.trim()));
  }
}

interface RawIssue { number: number; labels: { name: string }[]; body: string }

const toIssues = (raw: RawIssue[]): Issue[] =>
  raw.map((r) => ({
    id: r.number,
    labels: r.labels.map((l) => l.name),
    blockedBy: parseBlockedBy(r.body),
  }));
