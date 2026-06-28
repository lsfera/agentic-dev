/**
 * SandboxRunner — the sandcastle adapter. Uses the high-level `createSandbox`
 * lifecycle to work one issue in a disposable, git-isolated Docker sandbox:
 * the agent gets its own checkout on `agent/issue-<N>`, implements the issue,
 * and commits. Scope-bound disposal (`await using`) ensures the worktree and
 * container are torn down even if the agent throws. A `completionSignal` stops
 * the agent as soon as it is done so it does not loop and produce duplicate
 * commits (observed in the spike with no signal).
 *
 * Auth: `claudeCode` uses CLAUDE_CODE_OAUTH_TOKEN, which sandcastle resolves
 * from `.sandcastle/.env` (no Anthropic API key). See ADR-0003.
 *
 * Topology: `createSandbox` is invoked with `cwd` = the path-matched host
 * mount (the orchestrator's working directory), so the worktree sandcastle
 * bind-mounts into the inner container resolves under docker-outside-of-docker
 * (ADR-0011).
 *
 * The agent does NOT push or open the PR — the orchestrator does that with the
 * devcontainer's existing gh + SSH auth (walking-skeleton choice; keeps tokens
 * out of inner sandboxes).
 *
 * Lifecycle idiom (ADR-0019): createSandbox owns worktree creation and
 * deterministic teardown; in-sandbox setup is declared via hooks.onSandboxReady;
 * agent prompts are .md templates resolved by promptFile + promptArgs.
 */
import { createSandbox, claudeCode, opencode, type AgentProvider, type PromptArgs } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const _dir = dirname(fileURLToPath(import.meta.url));

const COMPLETION_SIGNAL = "<promise>ISSUE_COMPLETE</promise>";

/**
 * Docker label applied to every inner sandbox image (via Dockerfile LABEL).
 * Used for label-scoped container sweeps on startup and shutdown.
 */
export const SANDBOX_LABEL = "agentic.sandbox=1";

/**
 * Docker label *key* carrying the project a sandbox belongs to. Baked into the
 * per-project inner image at build time (Dockerfile `ARG AGENTIC_PROJECT` →
 * `LABEL`) and inherited by every container. Used to scope the orphan sweep so
 * one project never reaps another project's in-flight sandboxes (#40). Legacy
 * images built before this label simply carry an empty value and are treated as
 * unowned (swept by any project) for backward compatibility.
 */
export const PROJECT_LABEL_KEY = "agentic.sandbox.project";

/** Derive the project identifier from an "owner/name" repo or a directory path. */
export function deriveProject(repo: string | undefined, cwd: string): string {
  if (repo && repo.includes("/")) return repo.split("/").pop()!.trim();
  if (repo && repo.trim()) return repo.trim();
  return cwd.replace(/\/+$/, "").split("/").pop() ?? "";
}

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
  /** Docker network to attach the inner sandbox to. Used to give the sandbox a
   *  path-correct MTU (Docker's default bridge advertises MTU 65535 while the
   *  Docker-Desktop path is ~1400, a PMTUD black hole that stalls the agent's
   *  streaming API/Ollama responses after the first chunk → empty turns, #48).
   *  The orchestrator creates an MTU-1400 network and passes it here. */
  readonly network?: string;
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

/** Resolved agent-tier inputs: agent provider, docker image, network, any
 *  extra worktree files to copy, any in-sandbox setup commands, and the
 *  prompt template path + args for this issue. */
export interface AgentInput {
  readonly agent: AgentProvider;
  readonly imageName: string;
  readonly network?: string;
  readonly copyToWorktree?: string[];
  /** Commands run inside the sandbox after it boots, before the agent runs. */
  readonly onSandboxReady?: SandboxReadyHook[];
  /** Absolute path to the .md prompt template (resolved against import.meta.url). */
  readonly promptFile: string;
  /** {{KEY}} substitution args for the prompt template. */
  readonly promptArgs: PromptArgs;
}

export interface IssueInput {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

/** Pure function: resolve RunnerOptions + IssueInput to the per-tier agent
 *  config, including the prompt template path and substitution args. */
export function buildAgentInput(opts: RunnerOptions, issue: IssueInput): AgentInput {
  const promptArgs: PromptArgs = {
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body || "(no body)",
  };

  if (opts.tier === "local") {
    return {
      agent: opencode(opts.localModel ?? "ollama/qwen3-coder:30b"),
      imageName: opts.localImageName ?? "sandcastle-opencode:local",
      network: opts.network,
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
      promptFile: join(_dir, "prompt-local.md"),
      promptArgs,
    };
  }
  return {
    agent: claudeCode(opts.model ?? "claude-sonnet-4-6", { permissionMode: "auto" }),
    imageName: opts.imageName ?? "sandcastle:local",
    network: opts.network,
    promptFile: join(_dir, "prompt-claude.md"),
    promptArgs,
  };
}

export class SandboxRunner {
  constructor(private readonly opts: RunnerOptions = {}) {}

  async runIssue(issue: IssueInput): Promise<SandboxOutcome> {
    const branch = `agent/issue-${issue.number}`;
    const agentInput = buildAgentInput(this.opts, issue);

    // createSandbox owns worktree creation and teardown (ADR-0019); `await
    // using` ensures close() fires even if sandbox.run() throws, replacing the
    // old bespoke try/finally lifecycle.
    await using sandbox = await createSandbox({
      branch,
      sandbox: docker({
        imageName: agentInput.imageName,
        containerUid: this.opts.containerUid ?? 1000,
        containerGid: this.opts.containerGid ?? 1000,
        ...(agentInput.network ? { network: agentInput.network } : {}),
      }),
      cwd: this.opts.cwd,
      copyToWorktree: agentInput.copyToWorktree,
      hooks: agentInput.onSandboxReady
        ? { sandbox: { onSandboxReady: agentInput.onSandboxReady } }
        : undefined,
    });

    const result = await sandbox.run({
      agent: agentInput.agent,
      name: `issue-${issue.number}`,
      maxIterations: this.opts.maxIterations ?? 12,
      completionSignal: COMPLETION_SIGNAL,
      promptFile: agentInput.promptFile,
      promptArgs: agentInput.promptArgs,
    });

    return {
      branch: sandbox.branch,
      commits: result.commits,
      completed: result.completionSignal !== undefined,
      logFilePath: result.logFilePath,
    };
  }
}
