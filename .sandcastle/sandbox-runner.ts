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

/**
 * Docker label applied to every inner sandbox image (via Dockerfile LABEL).
 * Used for label-scoped container sweeps on startup and shutdown.
 */
export const SANDBOX_LABEL = "agentic.sandbox=1";

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

/** A command to run inside the sandbox once it is ready (sandcastle's
 *  `hooks.sandbox.onSandboxReady` shape). */
interface SandboxReadyHook {
  readonly command: string;
  readonly sudo?: boolean;
}

/** Resolved agent-tier inputs: agent provider, docker image, any extra
 *  worktree files to copy, and any in-sandbox setup commands. */
export interface AgentInput {
  readonly agent: AgentProvider;
  readonly imageName: string;
  readonly copyToWorktree?: string[];
  /** Commands run inside the sandbox after it boots, before the agent runs. */
  readonly onSandboxReady?: SandboxReadyHook[];
}

/** Pure function: resolve RunnerOptions to the per-tier agent config. */
export function buildAgentInput(opts: RunnerOptions): AgentInput {
  if (opts.tier === "local") {
    return {
      agent: opencode(opts.localModel ?? "ollama/qwen3-coder:30b"),
      imageName: opts.localImageName ?? "sandcastle-opencode:local",
      copyToWorktree: ["opencode.json"],
      // opencode resolves its Ollama provider from its *global* config
      // (~/.config/opencode/opencode.json), NOT from a config in the worktree
      // cwd under sandcastle's launch — without this the provider never resolves,
      // opencode bails before any inference (Ollama shows no model loaded), and
      // every iteration is an empty "started → stopped" turn. Relocate the
      // copied worktree config into opencode's global path so the model loads.
      onSandboxReady: [
        {
          command:
            "mkdir -p \"$HOME/.config/opencode\" && " +
            "cp opencode.json \"$HOME/.config/opencode/opencode.json\"",
        },
      ],
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
      hooks: agentInput.onSandboxReady
        ? { sandbox: { onSandboxReady: agentInput.onSandboxReady } }
        : undefined,
      prompt: buildPrompt(issue, this.opts.tier),
    });

    return {
      branch: result.branch,
      commits: result.commits,
      completed: result.completionSignal !== undefined,
      logFilePath: result.logFilePath,
    };
  }
}

/** Per-tier prompt. Local models (opencode) get a short, action-first prompt:
 *  the verbose claude prompt produces empty turns on smaller models — they need
 *  a direct "edit the file now, then these exact commands" shape. */
function buildPrompt(issue: IssueInput, tier?: "claude" | "local"): string {
  if (tier === "local") return buildLocalPrompt(issue);
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
    "- Make the changes yourself: use the edit/write tools to modify files and bash",
    "  to run tests and commit. Do not just plan or write a todo list, and do not",
    "  delegate to a subagent — apply the edits and commit them directly.",
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

/** Short, directive prompt for local opencode models. Action-first, concrete
 *  commands, minimal prose — verbose instructions produce empty turns. */
function buildLocalPrompt(issue: IssueInput): string {
  return [
    `Implement this change in the repository, then commit. Use your tools now — read files, edit files, run bash. Do not just describe a plan.`,
    "",
    `TASK (issue #${issue.number}): ${issue.title}`,
    issue.body || "(no body)",
    "",
    "The code lives in the `.sandcastle/` directory (TypeScript). Steps:",
    "1. Read the relevant `.sandcastle/*.ts` file(s) with your read tool.",
    "2. Make the change with your edit tool.",
    "3. Run the tests: `cd .sandcastle && npm test` — fix until they pass.",
    `4. Commit: \`cd .sandcastle && cd .. && git add -A && git commit -m "<message> (#${issue.number})"\``,
    "5. Do NOT push or open a PR.",
    "",
    `When committed, output this exact line alone and stop:`,
    COMPLETION_SIGNAL,
    "",
    "Begin now by reading the most relevant file.",
  ].join("\n");
}
