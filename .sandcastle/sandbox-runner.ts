/**
 * SandboxRunner — the sandcastle adapter. Wraps `run()` to work one issue in a
 * disposable, git-isolated Docker sandbox: the agent gets its own checkout on
 * `agent/issue-<N>`, implements the issue, and commits. A `completionSignal`
 * stops it as soon as it is done so it does not loop and produce duplicate
 * commits (observed in the spike with no signal).
 *
 * Auth: `claudeCode` uses CLAUDE_CODE_OAUTH_TOKEN, which sandcastle resolves
 * from `.sandcastle/.env` (no Anthropic API key). See ADR-0003.
 *
 * Topology: `run()` is invoked with `cwd` = the path-matched host mount (the
 * orchestrator's working directory), so the worktree sandcastle bind-mounts
 * into the inner container resolves under docker-outside-of-docker (ADR-0011).
 *
 * The agent does NOT push or open the PR — the orchestrator does that with the
 * devcontainer's existing gh + SSH auth (walking-skeleton choice; keeps tokens
 * out of inner sandboxes).
 */
import { run, claudeCode, opencode, type AgentProvider } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const COMPLETION_SIGNAL = "<promise>ISSUE_COMPLETE</promise>";

export interface SandboxOutcome {
  readonly branch: string;
  readonly commits: { sha: string }[];
  /** Whether the completion signal fired (vs. hitting the iteration cap). */
  readonly completed: boolean;
  readonly logFilePath?: string;
}

export interface RunnerOptions {
  readonly imageName?: string;
  readonly model?: string;
  /** Agent tier: "claude" (default, uses claudeCode + CLAUDE_CODE_OAUTH_TOKEN)
   *  or "local" (uses opencode against the host Ollama server). */
  readonly tier?: "claude" | "local";
  /** Model for the local Ollama tier (default: "ollama/qwen3-coder:30b"). */
  readonly localModel?: string;
  /** Inner image for the local tier (default: "sandcastle-opencode:local"). */
  readonly localImageName?: string;
  /** Host repo root; anchors sandcastle worktrees/.env. Should be the
   *  path-matched mount (process.cwd() of the orchestrator). */
  readonly cwd?: string;
  readonly maxIterations?: number;
  /** UID/GID baked into the inner image (Dockerfile ARG AGENT_UID/GID = 1000).
   *  Must match the image, NOT the host user — sandcastle otherwise defaults to
   *  the host UID, which mismatches on a host-direct run (e.g. macOS uid 501).
   *  A no-op in the devcontainer, where the user is already 1000. */
  readonly containerUid?: number;
  readonly containerGid?: number;
}

/** Resolved agent-tier inputs: agent provider, docker image, and any extra
 *  worktree files to copy before the sandbox starts. */
export interface AgentInput {
  readonly agent: AgentProvider;
  readonly imageName: string;
  readonly copyToWorktree?: string[];
}

/** Pure function: resolve RunnerOptions to the per-tier agent config. */
export function buildAgentInput(opts: RunnerOptions): AgentInput {
  if (opts.tier === "local") {
    return {
      agent: opencode(opts.localModel ?? "ollama/qwen3-coder:30b"),
      imageName: opts.localImageName ?? "sandcastle-opencode:local",
      copyToWorktree: ["opencode.json"],
    };
  }
  return {
    agent: claudeCode(opts.model ?? "claude-sonnet-4-6", { permissionMode: "auto" }),
    imageName: opts.imageName ?? "sandcastle:local",
  };
}

export interface IssueInput {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export class SandboxRunner {
  constructor(private readonly opts: RunnerOptions = {}) {}

  async runIssue(issue: IssueInput): Promise<SandboxOutcome> {
    const branch = `agent/issue-${issue.number}`;
    const agentInput = buildAgentInput(this.opts);
    const result = await run({
      agent: agentInput.agent,
      sandbox: docker({
        imageName: agentInput.imageName,
        containerUid: this.opts.containerUid ?? 1000,
        containerGid: this.opts.containerGid ?? 1000,
      }),
      branchStrategy: { type: "branch", branch },
      cwd: this.opts.cwd,
      name: `issue-${issue.number}`,
      maxIterations: this.opts.maxIterations ?? 12,
      completionSignal: COMPLETION_SIGNAL,
      copyToWorktree: agentInput.copyToWorktree,
      prompt: buildPrompt(issue),
    });

    return {
      branch: result.branch,
      commits: result.commits,
      completed: result.completionSignal !== undefined,
      logFilePath: result.logFilePath,
    };
  }
}

function buildPrompt(issue: IssueInput): string {
  return [
    `You are implementing GitHub issue #${issue.number}: "${issue.title}"`,
    "",
    "## Issue",
    issue.body || "(no body)",
    "",
    "## Scope guardrails",
    "- Only modify files directly required by this issue.",
    "- Do not modify, close, or reference other issues.",
    "- Do not add dependencies beyond what the issue specifies.",
    "- Do not push or open a pull request — the orchestrator does that after you finish.",
    "",
    "## Steps",
    "1. Implement the change. If the project has a test suite, work test-first:",
    "   write a failing test, make it pass, then refactor.",
    "2. Run the test suite and make sure it is green.",
    "3. Commit your work to the current branch with clear, imperative messages",
    `   referencing #${issue.number}.`,
    "4. When the issue is fully implemented and committed, output exactly this",
    "   line, by itself, and then stop — produce no further output or commits:",
    `   ${COMPLETION_SIGNAL}`,
  ].join("\n");
}
