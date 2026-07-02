/**
 * Cross-run memory — pure logic (ADR-0022). Formatting, parsing, and
 * category-cap selection for the hand-rolled, GitHub-issue-backed memory
 * store. No I/O here — issue-source.ts carries out the gh calls,
 * memory-store.ts composes the two (in the same spirit as reduce.ts / issue-source.ts).
 *
 * Three categories:
 *   repo-convention — agent-emitted; always injected in full.
 *   gotcha          — agent-emitted; capped at last N.
 *   outcome         — orchestrator-emitted, one per issue at terminal state; capped at last N.
 */

export const MEMORY_LABEL = "agent:memory";
export const MEMORY_ISSUE_TITLE = "Agent memory (do not close)";
export const MEMORY_ISSUE_BODY =
  "Durable cross-run memory for this repo's agent runs (ADR-0022). Do not close — " +
  "comments here are read by future runs. Safe to edit or delete individual comments.";

const MARKER = "<!-- agentic-memory -->";

export type MemoryCategory = "repo-convention" | "gotcha" | "outcome";

const CATEGORIES: readonly MemoryCategory[] = ["repo-convention", "gotcha", "outcome"];

/** Per-category cap for MEMORY_CONTEXT injection; undefined = uncapped (inject in full). */
const CAPS: Record<MemoryCategory, number | undefined> = {
  "repo-convention": undefined,
  gotcha: 5,
  outcome: 5,
};

export interface MemoryEntry {
  readonly category: MemoryCategory;
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Format one memory entry as a GitHub issue comment body. */
export function formatMemoryComment(entry: MemoryEntry): string {
  const fieldLines = [
    `**Category:** ${entry.category}`,
    ...Object.entries(entry.fields).map(([k, v]) => `**${k}:** ${v}`),
  ];
  return [MARKER, ...fieldLines, "", entry.body].join("\n");
}

/**
 * Parse a comment body back into a MemoryEntry, or null when it isn't a
 * marked memory comment or carries an unrecognized category — dropped
 * silently rather than coerced, per ADR-0022's fail-open policy.
 */
export function parseMemoryComment(body: string): MemoryEntry | null {
  if (!body.includes(MARKER)) return null;

  const lines = body.split("\n");
  const fields: Record<string, string> = {};
  let category: MemoryCategory | null = null;
  let bodyStart = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fieldMatch = line.match(/^\*\*([^*]+):\*\*\s*(.*)$/);
    if (fieldMatch) {
      const [, key, value] = fieldMatch;
      if (key === "Category") {
        if ((CATEGORIES as readonly string[]).includes(value)) {
          category = value as MemoryCategory;
        } else {
          return null; // unrecognized category — drop, don't coerce
        }
      } else {
        fields[key] = value;
      }
      continue;
    }
    if (line.trim() === "" || line.trim() === MARKER) continue;
    bodyStart = i;
    break;
  }

  if (!category) return null;
  return { category, fields, body: lines.slice(bodyStart).join("\n").trim() };
}

/**
 * Parse agent-emitted <repo-convention>/<gotcha> tags out of raw run stdout.
 * Fixed tag names (not a category attribute) make an unrecognized category a
 * syntax-level impossibility. Unclosed/malformed tags simply don't match and
 * are dropped — fail-open, no parse-error path (ADR-0022).
 */
export function parseMemoryTags(stdout: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const category of ["repo-convention", "gotcha"] as const) {
    const re = new RegExp(`<${category}>([\\s\\S]*?)</${category}>`, "g");
    for (const match of stdout.matchAll(re)) {
      const body = match[1].trim();
      if (body) entries.push({ category, fields: {}, body });
    }
  }
  return entries;
}

export interface OutcomeAttempt {
  readonly succeeded: boolean;
  /** Failure reason, e.g. "sandbox timeout after 12 iterations". Ignored when succeeded. */
  readonly note?: string;
}

/** Build the orchestrator's single outcome entry for one issue at terminal state. */
export function buildOutcomeEntry(input: {
  readonly issueNumber: number;
  readonly prNumber?: number;
  readonly attempts: readonly OutcomeAttempt[];
}): MemoryEntry {
  const last = input.attempts[input.attempts.length - 1];
  const fields: Record<string, string> = {
    Issue: `#${input.issueNumber}`,
    Result: last?.succeeded ? "succeeded" : "failed",
    Attempts: String(input.attempts.length),
  };
  if (input.prNumber !== undefined) fields.PR = `#${input.prNumber}`;

  const body = input.attempts
    .map((attempt, i) => {
      const n = i + 1;
      if (attempt.succeeded) return `Attempt ${n} succeeded.`;
      return `Attempt ${n} failed${attempt.note ? `: ${attempt.note}` : "."}`;
    })
    .join("\n");

  return { category: "outcome", fields, body };
}

/** Select entries for prompt injection: repo-convention in full, gotcha/outcome capped at last N.
 *  Assumes `entries` is ordered oldest-first (as gh returns issue comments). */
export function selectMemoryContext(entries: readonly MemoryEntry[]): MemoryEntry[] {
  const byCategory = new Map<MemoryCategory, MemoryEntry[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  const result: MemoryEntry[] = [];
  for (const category of CATEGORIES) {
    const list = byCategory.get(category);
    if (!list) continue;
    const cap = CAPS[category];
    result.push(...(cap === undefined ? list : list.slice(-cap)));
  }
  return result;
}

/** Render selected entries as the {{MEMORY_CONTEXT}} prompt substitution. */
export function renderMemoryContext(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return "(no prior memory for this repo)";
  return entries
    .map((entry) => {
      const fieldSummary = Object.entries(entry.fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      return `[${entry.category}]${fieldSummary ? ` (${fieldSummary})` : ""} ${entry.body}`;
    })
    .join("\n\n");
}
