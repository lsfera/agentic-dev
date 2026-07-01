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
import { run, claudeCode, Output, StructuredOutputError } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { reviewVerdict, type ReviewOutput, type ReviewVerdict } from "./reduce.ts";
import { getCompressionCallback } from "./context-compressor.js";

const _dir = dirname(fileURLToPath(import.meta.url));

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
    promptFile: join(_dir, "review-prompt.md"),
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
    promptFile: join(_dir, "review-extraction.md"),
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
   * "changes-requested" via reviewVerdict()).
   */
  async review(input: ReviewInput): Promise<ReviewOutput | null> {
    const model = this.opts.model ?? "claude-sonnet-4-6";
    const cwd = this.opts.cwd;

    const passOneConfig = buildReviewerPassOneConfig(this.opts, input);
    const compression = getCompressionCallback();

    // Pass 1: produce — the reviewer reads the diff and forms a free-form review.
    let reviewResult;
    try {
      // Pre-read template, resolve args, optionally compress — outside sandcastle's Effect generators.
      if (compression) {
        const raw = await readFile(join(_dir, "review-prompt.md"), "utf8");
        let text = raw;
        for (const [key, value] of Object.entries(passOneConfig.promptArgs)) {
          text = text.replaceAll(`{{${key}}}`, String(value));
        }
        const compressed = await compression(text);

        reviewResult = await run({
          agent: claudeCode(model, { permissionMode: "auto" }),
          sandbox: noSandbox(),
          cwd,
          prompt: compressed,
        });
      } else {
        reviewResult = await run({
          agent: claudeCode(model, { permissionMode: "auto" }),
          sandbox: noSandbox(),
          cwd,
          ...passOneConfig,
        });
      }
    } catch (err) {
      console.warn(`[reviewer] pass-1 (produce) failed for #${input.issueNumber}:`, err);
      return null;
    }

    const passTwoConfig = buildReviewerPassTwoConfig(input);

    if (!reviewResult.resume) {
      console.warn(`[reviewer] resume not available after pass-1 for #${input.issueNumber} — using fresh run for extraction`);
    }

    // Pass 2: extract — resume the session and ask for the structured output block.
    try {
      let extractResult;
      if (compression) {
        const raw = await loadPromptFile(passTwoConfig.promptFile);
        const compressed = await compression(raw);

        extractResult = reviewResult.resume
          ? await reviewResult.resume(compressed, {
              output: Output.object({ tag: "output", schema: reviewOutputSchema }),
              cwd,
            })
          : await run({
              agent: claudeCode(model, { permissionMode: "auto" }),
              sandbox: noSandbox(),
              cwd,
              prompt: compressed,
              output: Output.object({ tag: "output", schema: reviewOutputSchema }),
              name: passTwoConfig.name,
            });
      } else {
        extractResult = reviewResult.resume
          ? await reviewResult.resume(
              await loadPromptFile(join(_dir, "review-extraction.md")),
              {
                output: Output.object({ tag: "output", schema: reviewOutputSchema }),
                cwd,
              },
            )
          : await run({
              agent: claudeCode(model, { permissionMode: "auto" }),
              sandbox: noSandbox(),
              cwd,
              promptFile: passTwoConfig.promptFile,
              output: Output.object({ tag: "output", schema: reviewOutputSchema }),
              name: passTwoConfig.name,
            });
      }

      return (extractResult as typeof extractResult & { output: ReviewOutput }).output;
    } catch (err) {
      if (err instanceof StructuredOutputError) {
        console.warn(
          `[reviewer] structured output extraction failed for #${input.issueNumber}: ${err.message}`,
        );
      } else {
        console.warn(`[reviewer] pass-2 (extract) failed for #${input.issueNumber}:`, err);
      }
      return null;
    }
  }

  /**
   * Run a full review pass: run the agent, validate output, filter comments to
   * diff-only lines, and return the verdict. On any failure, returns
   * "changes-requested" (fail-safe).
   */
  async runReview(input: ReviewInput, diff: string): Promise<{ verdict: ReviewVerdict; output: ReviewOutput | null }> {
    const raw = await this.review(input);
    const verdict = reviewVerdict(raw instanceof Error ? raw : raw);

    if (raw && raw.comments.length > 0) {
      const diffLines = parseDiffLines(diff);
      const filtered: ReviewOutput = {
        ...raw,
        comments: filterInlineComments(raw.comments, diffLines),
      };
      return { verdict, output: filtered };
    }

    return { verdict, output: raw };
  }
}

async function loadPromptFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
