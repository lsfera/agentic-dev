/**
 * IssueSource — the GitHub adapter. Thin wrapper over the `gh` CLI: list ready
 * issues, read one, claim/relabel, comment, and open a PR. No decision logic
 * lives here (that is the reducer's job); this only carries out actions and
 * shapes GitHub state into the reducer's `Issue` type.
 *
 * Runs inside the outer devcontainer, where `gh` is already authenticated.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { READY_LABEL, type Issue } from "./reduce.ts";

const exec = promisify(execFile);

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

  private gh(args: string[]) {
    const full = this.repo ? ["-R", this.repo, ...args] : args;
    return exec("gh", full, { maxBuffer: 16 * 1024 * 1024 });
  }

  /** Open issues carrying the ready label, with dependency refs parsed from body. */
  async listReady(): Promise<Issue[]> {
    const { stdout } = await this.gh([
      "issue", "list",
      "--state", "open",
      "--label", READY_LABEL,
      "--json", "number,labels,body",
    ]);
    const raw = JSON.parse(stdout) as { number: number; labels: { name: string }[]; body: string }[];
    return raw.map((r) => ({
      id: r.number,
      labels: r.labels.map((l) => l.name),
      blockedBy: parseBlockedBy(r.body),
    }));
  }

  /** All open issues (regardless of label), with dependency refs parsed. */
  async listAll(): Promise<Issue[]> {
    const { stdout } = await this.gh([
      "issue", "list",
      "--state", "open",
      "--json", "number,labels,body",
    ]);
    const raw = JSON.parse(stdout) as { number: number; labels: { name: string }[]; body: string }[];
    return raw.map((r) => ({
      id: r.number,
      labels: r.labels.map((l) => l.name),
      blockedBy: parseBlockedBy(r.body),
    }));
  }

  /** Merged PRs opened from `agent/issue-N` branches, mapped back to issue ids. */
  async listMergedPrs(): Promise<import("./reduce.ts").Pr[]> {
    const { stdout } = await this.gh([
      "pr", "list",
      "--state", "merged",
      "--json", "number,headRefName",
    ]);
    const raw = JSON.parse(stdout) as { number: number; headRefName: string }[];
    return raw
      .map((pr) => {
        const m = pr.headRefName.match(/issue-(\d+)$/);
        return m
          ? { issue: parseInt(m[1], 10), ciStatus: "success" as import("./reduce.ts").CiStatus, merged: true }
          : null;
      })
      .filter((pr): pr is import("./reduce.ts").Pr => pr !== null);
  }

  /** Open PRs from `agent/issue-N` branches, mapped back to issue ids. */
  async listOpenPrs(): Promise<import("./reduce.ts").Pr[]> {
    const { stdout } = await this.gh([
      "pr", "list",
      "--state", "open",
      "--json", "number,headRefName,mergeable",
    ]);
    const raw = JSON.parse(stdout) as {
      number: number;
      headRefName: string;
      mergeable: string;
    }[];
    return raw
      .map((pr) => {
        const m = pr.headRefName.match(/issue-(\d+)$/);
        if (!m) return null;
        // A CONFLICTING PR can never auto-merge; mark it so the reducer does
        // not keep the loop alive forever waiting on it (#23).
        const ciStatus = (
          pr.mergeable === "CONFLICTING" ? "conflicting" : "pending"
        ) as import("./reduce.ts").CiStatus;
        return { issue: parseInt(m[1], 10), ciStatus, merged: false };
      })
      .filter((pr): pr is import("./reduce.ts").Pr => pr !== null);
  }

  /** Enable GitHub-native auto-merge on the PR for the given issue. */
  async enableAutoMerge(issueId: number): Promise<void> {
    await this.gh(["pr", "merge", `agent/issue-${issueId}`, "--auto", "--squash"]);
  }

  async get(n: number): Promise<GhIssue> {
    const { stdout } = await this.gh([
      "issue", "view", String(n),
      "--json", "number,title,body,labels",
    ]);
    return JSON.parse(stdout) as GhIssue;
  }

  async removeLabel(n: number, label: string): Promise<void> {
    await this.gh(["issue", "edit", String(n), "--remove-label", label]);
  }

  async addLabel(n: number, label: string): Promise<void> {
    await this.gh(["issue", "edit", String(n), "--add-label", label]);
  }

  async comment(n: number, body: string): Promise<void> {
    await this.gh(["issue", "comment", String(n), "--body", body]);
  }

  /** Open a PR for an already-pushed head branch. Returns the PR URL. */
  async openPr(opts: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<string> {
    const { stdout } = await this.gh([
      "pr", "create",
      "--head", opts.head,
      "--base", opts.base,
      "--title", opts.title,
      "--body", opts.body,
    ]);
    return stdout.trim();
  }
}
