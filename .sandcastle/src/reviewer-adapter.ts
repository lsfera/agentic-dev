/**
 * ReviewerAdapter — runs a read-only reviewer sandbox on a PR branch and
 * returns a structured verdict. Uses a two-pass produce→extract pattern:
 *
 *   Pass 1 (prompt.md): the agent reads the diff + ADRs + acceptance criteria
 *             and forms a free-form review.
 *   Pass 2 (extraction.md): the same session is resumed; the agent's only job
 *             is to emit a structured <output> block with the verdict JSON.
 *
 * The reviewer runs in noSandbox() — it reads the branch via `git diff` and
 * `gh`, but never pushes or commits.
 *
 * Fail-safe: any exception (timeout, missing tag, schema failure) is caught and
 * returns `null`, which the orchestrator maps to "changes-requested" via
 * reviewVerdict() in reduce.ts.
 *
 * Prior art: mattpocock/sandcastle agent-workflows/review/ pattern (ADR-0020).
 */
import { Effect } from "effect";
import { run, claudeCode, Output, StructuredOutputError } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { reviewVerdict, type ReviewOutput, type ReviewVerdict } from "./reduce.ts";
import { getCompressionCallback } from "./context-compressor.js";

const _dir = dirname(fileURLToPath(import.meta.url));

/**
 * Force Claude Code to authenticate via CLAUDE_CODE_OAUTH_TOKEN (subscription,
 * ADR-0003) instead of ANTHROPIC_API_KEY (pay-as-you-go). The reviewer runs via
 * noSandbox() + sandcastle's top-level run(), which inherits the devcontainer's
 * own process env — that env carries ANTHROPIC_API_KEY (ADR-0018 cockpit
 * passthrough; also needed by the headroom proxy's own compress() calls, see
 * ADR-0023) alongside CLAUDE_CODE_OAUTH_TOKEN (from .sandcastle/.env, resolved
 * separately by sandcastle for agent auth). Claude Code prefers an explicit API
 * key over the subscription token whenever both are present, so every review
 * silently authenticated against the API key instead — and failed outright
 * ("Credit balance is too low") once that key's balance ran out, masked by an
 * unrelated "workspace not trusted" warning that always prints alongside it.
 * Live-verified: clearing the key here (empty string, not omitting it — Claude
 * Code only falls back to OAuth when the var is unset/empty) restores the
 * working OAuth path. Confirmed this works on the top-level run() path (unlike
 * SandboxRunner's createSandbox()+.run() path, where AgentProvider.env is
 * silently ignored entirely — see sandbox-runner.ts's `sandboxEnv` field).
 */
const FORCE_OAUTH_ENV = { ANTHROPIC_API_KEY: "" };

/** Standard Schema-compatible validator for the reviewer's structured output. */
const reviewOutputSchema = {
  "~standard": {
    validate(value: unknown): { value: ReviewOutput } | { issues: unknown[] } {
      if (!value || typeof value !== "object") {
        return { issues: [{ message: "expected an object" }] };
      }
      const v = value as Record<string, unknown>;
      if (v.verdict !== "pass" && v.verdict !== "changes-requested") {
        return { issues: [{ message: `verdict must be 'pass' or 'changes-requested', got ${JSON.stringify(v.verdict)}` }] };
      }
      if (typeof v.summary !== "string") {
        return { issues: [{ message: "summary must be a string" }] };
      }
      if (!Array.isArray(v.comments)) {
        return { issues: [{ message: "comments must be an array" }] };
      }
      return { value: value as ReviewOutput };
    },
    version: 1,
  },
} as const;

export interface ReviewerOptions {
  /** Model to use for the reviewer agent (default: claude-sonnet-4-6). */
  readonly model?: string;
  /** Host repo root — anchors sandcastle's cwd and git operations. */
  readonly cwd?: string;
  /** Base branch the PR was cut from (used in the diff command). */
  readonly baseBranch?: string;
}

export interface ReviewInput {
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly branch: string;
  /** PR number for posting the review. */
  readonly prNumber: number;
}

/**
 * Parse a unified diff and return a Set of "path:line" pairs for all lines
 * that appear in diff hunks (both added and context lines). Used by
 * filterInlineComments to drop comments whose path/line aren't in the diff.
 */
export function parseDiffLines(diff: string): Set<string> {
  const result = new Set<string>();
  let currentFile = "";
  let currentLine = 0;

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10) - 1;
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith("-")) continue; // removed lines have no new-file line number
    if (line.startsWith("+") || line.startsWith(" ")) {
      currentLine++;
      result.add(`${currentFile}:${currentLine}`);
    }
  }

  return result;
}

/**
 * Filter inline review comments to only those whose path+line appear in the
 * diff hunks. Mirrors the reference's filterInlineComments guard so off-diff
 * line references (hallucinated or stale) are never posted to the PR.
 */
export function filterInlineComments(
  comments: ReviewOutput["comments"],
  diffLines: Set<string>,
): ReviewOutput["comments"] {
  return comments.filter((c) => diffLines.has(`${c.path}:${c.line}`));
}

/** Pass-1 (produce) run options returned by buildReviewerPassOneConfig. */
export interface ReviewerPassOneConfig {
  readonly promptFile: string;
  readonly promptArgs: Record<string, string>;
  readonly name: string;
  // A review is a single-pass job: read diff → emit verdict → done.
  // maxIterations: 1 prevents sandcastle re-invoking the agent toward a
  // spurious second pass (observed at 8× in issue #80).
  readonly maxIterations: 1;
}

/** Pass-2 (extract) run options returned by buildReviewerPassTwoConfig. */
export interface ReviewerPassTwoConfig {
  /** The extraction prompt file path — review-extraction.md with no {{KEY}} placeholders. */
  readonly promptFile: string;
  /** No args needed: review-extraction.md has zero template keys. */
  readonly name: string;
}

/**
 * Pure function: resolve ReviewerOptions + ReviewInput to the produce-pass
 * run options — no Docker, no network. Mirrors buildAgentInput in
 * sandbox-runner.ts; the caller wires in agent/sandbox/cwd before calling run().
 */
export function buildReviewerPassOneConfig(
  opts: ReviewerOptions,
  input: ReviewInput,
): ReviewerPassOneConfig {
  const baseBranch = opts.baseBranch ?? "main";
  return {
    promptFile: join(_dir, "..", "prompts", "review-prompt.md"),
    promptArgs: {
      ISSUE_NUMBER: String(input.issueNumber),
      ISSUE_TITLE: input.issueTitle,
      ISSUE_BODY: input.issueBody || "(no body)",
      BRANCH: input.branch,
      BASE_BRANCH: baseBranch,
    },
    name: `review-issue-${input.issueNumber}`,
    maxIterations: 1,
  };
}

/**
 * Pure function: resolve the extraction-pass run options — no Docker, no network.
 * Mirrors buildReviewerPassOneConfig from #80. The extraction template has zero
 * {{KEY}} placeholders so promptArgs are not needed (and would conflict with inline
 * prompts per sandcastle's constraint). The caller wires in agent/sandbox/cwd/output
 * before calling run().
 */
export function buildReviewerPassTwoConfig(input: ReviewInput): ReviewerPassTwoConfig {
  return {
    promptFile: join(_dir, "..", "prompts", "review-extraction.md"),
    name: `review-extract-${input.issueNumber}`,
  };
}

export class ReviewerAdapter {
  private readonly opts: ReviewerOptions;

  constructor(opts: ReviewerOptions = {}) {
    this.opts = opts;
  }

  /**
   * Run the reviewer on the given PR branch and return the validated structured
   * output, or null when extraction/validation fails (caller maps to
   * "changes-requested" via reviewVerdict()). Never fails: every failure is
   * logged and mapped to null (fail-safe).
   */
  review(input: ReviewInput): Effect.Effect<ReviewOutput | null> {
    const model = this.opts.model ?? "claude-sonnet-4-6";
    const cwd = this.opts.cwd;
    const passOneConfig = buildReviewerPassOneConfig(this.opts, input);
    const passTwoConfig = buildReviewerPassTwoConfig(input);
    const compression = getCompressionCallback();
    const agent = () => claudeCode(model, { permissionMode: "auto", env: FORCE_OAUTH_ENV });
    const outputSpec = () => Output.object({ tag: "output", schema: reviewOutputSchema });

    /** Fill a prompt template's {{KEY}} args, then compress it. */
    const compressTemplate = (file: string, args: Record<string, string> = {}) =>
      Effect.tryPromise(async () => {
        let text = await readFile(file, "utf8");
        for (const [key, value] of Object.entries(args)) {
          text = text.replaceAll(`{{${key}}}`, String(value));
        }
        return compression!(text);
      });

    // Pass 1: produce — the reviewer reads the diff and forms a free-form review.
    const passOne = Effect.gen(function* () {
      if (compression) {
        const prompt = yield* compressTemplate(passOneConfig.promptFile, passOneConfig.promptArgs);
        return yield* Effect.tryPromise(() =>
          run({
            agent: agent(),
            sandbox: noSandbox(),
            cwd,
            prompt,
            name: passOneConfig.name,
            maxIterations: passOneConfig.maxIterations,
          }),
        );
      }
      return yield* Effect.tryPromise(() =>
        run({ agent: agent(), sandbox: noSandbox(), cwd, ...passOneConfig }),
      );
    });

    // Pass 2: extract — resume the session and ask for the structured output block.
    const passTwo = (reviewResult: Effect.Success<typeof passOne>) =>
      Effect.gen(function* () {
        if (!reviewResult.resume) {
          console.warn(`[reviewer] resume not available after pass-1 for #${input.issueNumber} — using fresh run for extraction`);
        }
        const extractResult = compression
          ? yield* Effect.gen(function* () {
              const prompt = yield* compressTemplate(passTwoConfig.promptFile);
              return yield* Effect.tryPromise(() =>
                reviewResult.resume
                  ? reviewResult.resume(prompt, { output: outputSpec(), cwd })
                  : run({ agent: agent(), sandbox: noSandbox(), cwd, prompt, output: outputSpec(), name: passTwoConfig.name }),
              );
            })
          : yield* Effect.tryPromise(async () =>
              reviewResult.resume
                ? reviewResult.resume(await loadPromptFile(passTwoConfig.promptFile), { output: outputSpec(), cwd })
                : run({
                    agent: agent(),
                    sandbox: noSandbox(),
                    cwd,
                    promptFile: passTwoConfig.promptFile,
                    output: outputSpec(),
                    name: passTwoConfig.name,
                  }),
            );
        return (extractResult as typeof extractResult & { output: ReviewOutput }).output;
      });

    return passOne.pipe(
      Effect.catch((err) =>
        Effect.sync(() => console.warn(`[reviewer] pass-1 (produce) failed for #${input.issueNumber}:`, err.cause ?? err)).pipe(
          Effect.andThen(Effect.fail(null)),
        ),
      ),
      Effect.flatMap((reviewResult) =>
        passTwo(reviewResult).pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              const cause = err.cause;
              if (cause instanceof StructuredOutputError) {
                console.warn(`[reviewer] structured output extraction failed for #${input.issueNumber}: ${cause.message}`);
              } else {
                console.warn(`[reviewer] pass-2 (extract) failed for #${input.issueNumber}:`, cause ?? err);
              }
            }).pipe(Effect.andThen(Effect.fail(null))),
          ),
        ),
      ),
      Effect.catch(() => Effect.succeed(null)),
    );
  }

  /**
   * Run a full review pass: run the agent, validate output, filter comments to
   * diff-only lines, and return the verdict. On any failure, returns
   * "changes-requested" (fail-safe).
   */
  runReview(
    input: ReviewInput,
    diff: string,
  ): Effect.Effect<{ verdict: ReviewVerdict; output: ReviewOutput | null }> {
    return this.review(input).pipe(
      Effect.map((raw) => {
        const verdict = reviewVerdict(raw);
        if (raw && raw.comments.length > 0) {
          const diffLines = parseDiffLines(diff);
          const filtered: ReviewOutput = {
            ...raw,
            comments: filterInlineComments(raw.comments, diffLines),
          };
          return { verdict, output: filtered };
        }
        return { verdict, output: raw };
      }),
    );
  }
}

function loadPromptFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}
