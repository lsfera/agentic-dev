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
import { readFile } from "node:fs/promises";
import { getCompressionCallback, isCompressionActive } from "./context-compressor.js";
import { fileURLToPath } from "node:url";
import { withRetry } from "./retry.ts";

const _dir = dirname(fileURLToPath(import.meta.url));

const COMPLETION_SIGNAL = "<promise>ISSUE_COMPLETE</promise>";

/**
 * Substrings of known-transient agent/network failures — worth one quick
 * retry on the SAME sandbox (cheaper than the orchestrator's own #76
 * requeue, which throws away the whole sandbox and starts a fresh one).
 * Deliberately excludes session-limit / rate-limit / credit-balance style
 * messages: retrying those immediately can't help (they clear on their own
 * schedule, not ours), so they're left to fail fast and fall through to the
 * coarser requeue-on-a-later-tick retry instead of wasting an attempt now.
 */
const TRANSIENT_AGENT_ERROR_PATTERNS = [
  "server disconnected",
  "econnreset",
  "etimedout",
  "socket hang up",
  "fetch failed",
  "network error",
  "econnrefused",
];

/** Pure predicate: does this sandbox.run() failure look worth retrying immediately? */
export function isTransientAgentError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return TRANSIENT_AGENT_ERROR_PATTERNS.some((p) => lower.includes(p));
}

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
  /** Combined agent stdout across all iterations — scanned by the caller for
   *  optional <repo-convention>/<gotcha> memory tags (ADR-0022, memory.ts's
   *  parseMemoryTags). Kept here rather than in sandbox-runner.ts itself so
   *  this module stays free of GitHub I/O. */
  readonly stdout: string;
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
  /**
   * Extra env vars for the sandbox CONTAINER itself (docker()'s `env`, applied
   * via real `-e` flags at `docker run` time in createSandbox — confirmed by
   * reading @ai-hero/sandcastle 0.10.0's source). NOT the same as an
   * AgentProvider's own `.env` field: sandcastle's createSandbox() hardcodes
   * `agentProviderEnv: {}` when starting the container, and invokeAgent()'s
   * sandbox.exec() call never passes an env override either — so
   * `claudeCode(model, { env })` is silently never applied to the running
   * agent process. This field is the one that actually reaches the container.
   */
  readonly sandboxEnv?: Record<string, string>;
}

export interface IssueInput {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

/** Pure function: resolve RunnerOptions + IssueInput to the per-tier agent
 *  config, including the prompt template path and substitution args.
 *  `memoryContext` (ADR-0022) is the caller-retrieved {{MEMORY_CONTEXT}}
 *  rendering — this function stays free of GitHub I/O, matching the existing
 *  pure-reducer/impure-adapter split (memory-store.ts owns the retrieval). */
export function buildAgentInput(
  opts: RunnerOptions,
  issue: IssueInput,
  memoryContext?: string,
): AgentInput {
  const promptArgs: PromptArgs = {
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body || "(no body)",
    MEMORY_CONTEXT: memoryContext ?? "(no prior memory for this repo)",
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
    // Route the inner sandbox's whole live Claude Code session through the
    // headroom proxy (docker-compose.yml's `headroom` service), not just the
    // one-shot prompt compression above — compresses every turn, including
    // tool output and file contents the pre-read compression never sees.
    // host.docker.internal is how the inner sandbox already reaches host-side
    // services on agentic-sandbox-net (main.ts's ensureSandboxNetwork comment
    // — the same trick the local/Ollama tier uses): the proxy lives on
    // devcontainer-network, a separate compose network the inner sandbox
    // can't resolve by service name. Off unless HEADROOM_MODE is enabled.
    //
    // This MUST be sandboxEnv (applied to the docker() sandbox provider,
    // below), NOT claudeCode()'s own `env` option: live-verified against
    // @ai-hero/sandcastle 0.10.0 that an AgentProvider's `.env` is silently
    // discarded on the createSandbox()+.run() path this runner uses —
    // createSandbox() hardcodes `agentProviderEnv: {}` when starting the
    // container, and invokeAgent()'s sandbox.exec() call never applies an env
    // override either. Confirmed live: with it on claudeCode() only, a real
    // sandbox run completed commits but headroom's own /stats endpoint showed
    // api_requests: 0 the whole time. docker()'s `env` IS applied (real -e
    // flags at container-create time in startContainer), so container-level
    // env is inherited by every later `docker exec`.
    agent: claudeCode(opts.model ?? "claude-sonnet-4-6", {
      permissionMode: "auto",
    }),
    imageName: opts.imageName ?? "sandcastle:local",
    network: opts.network,
    sandboxEnv: isCompressionActive()
      ? { ANTHROPIC_BASE_URL: "http://host.docker.internal:8787" }
      : undefined,
    promptFile: join(_dir, "prompt-claude.md"),
    promptArgs,
  };
}

export class SandboxRunner {
  constructor(private readonly opts: RunnerOptions = {}) {}

  async runIssue(issue: IssueInput, memoryContext?: string): Promise<SandboxOutcome> {
    const branch = `agent/issue-${issue.number}`;
    const agentInput = buildAgentInput(this.opts, issue, memoryContext);

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
        ...(agentInput.sandboxEnv ? { env: agentInput.sandboxEnv } : {}),
      }),
      cwd: this.opts.cwd,
      copyToWorktree: agentInput.copyToWorktree,
      hooks: agentInput.onSandboxReady
        ? { sandbox: { onSandboxReady: agentInput.onSandboxReady } }
        : undefined,
    });

    // Resolve compression callback once (off by default — set HEADROOM_MODE=conservative or
    // aggressive to enable). Claude tier only: the local/Ollama tier has no token cost to save,
    // so compressing there would only add latency for no benefit.
    const compression = this.opts.tier === "local" ? undefined : getCompressionCallback();

    let runResult;
    if (compression) {
      // Pre-read template, resolve args, compress — outside sandcastle's Effect generators.
      const raw = await readFile(agentInput.promptFile, "utf8");
      let text = raw;
      for (const [key, value] of Object.entries(agentInput.promptArgs)) {
        text = text.replaceAll(`{{${key}}}`, String(value));
      }
      const compressed = await compression(text);

      runResult = await withRetry(
        () =>
          sandbox.run({
            agent: agentInput.agent,
            name: `issue-${issue.number}`,
            maxIterations: this.opts.maxIterations ?? 12,
            completionSignal: COMPLETION_SIGNAL,
            prompt: compressed,
          }),
        { maxAttempts: 2, baseDelayMs: 5_000, label: `issue-${issue.number} agent turn`, shouldRetry: isTransientAgentError },
      );
    } else {
      runResult = await withRetry(
        () =>
          sandbox.run({
            agent: agentInput.agent,
            name: `issue-${issue.number}`,
            maxIterations: this.opts.maxIterations ?? 12,
            completionSignal: COMPLETION_SIGNAL,
            promptFile: agentInput.promptFile,
            promptArgs: agentInput.promptArgs,
          }),
        { maxAttempts: 2, baseDelayMs: 5_000, label: `issue-${issue.number} agent turn`, shouldRetry: isTransientAgentError },
      );
    }

    const result = runResult;

    return {
      branch: sandbox.branch,
      commits: result.commits,
      completed: result.completionSignal !== undefined,
      logFilePath: result.logFilePath,
      stdout: result.stdout,
    };
  }
}
