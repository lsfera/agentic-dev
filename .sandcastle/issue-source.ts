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

  /** Open issues carrying the ready label. blockedBy is empty in slice 1;
   *  dependency parsing arrives with issue #2. */
  async listReady(): Promise<Issue[]> {
    const { stdout } = await this.gh([
      "issue", "list",
      "--state", "open",
      "--label", READY_LABEL,
      "--json", "number,labels",
    ]);
    const raw = JSON.parse(stdout) as { number: number; labels: { name: string }[] }[];
    return raw.map((r) => ({
      id: r.number,
      labels: r.labels.map((l) => l.name),
      blockedBy: [],
    }));
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
