/**
 * Memory store — I/O orchestration for cross-run memory (ADR-0022). Composes
 * memory.ts (pure formatting/parsing/selection) with IssueSource (gh I/O),
 * mirroring the reduce.ts / issue-source.ts split: decision logic stays pure
 * and testable, this layer only carries it out.
 *
 * Fail-open throughout (ADR-0022): a read or write failure is logged and
 * swallowed here, not surfaced to the caller — memory is an optimization,
 * never a reason to block or retry a sandbox run.
 */
import {
  MEMORY_LABEL,
  MEMORY_ISSUE_TITLE,
  MEMORY_ISSUE_BODY,
  formatMemoryComment,
  parseMemoryComment,
  selectMemoryContext,
  renderMemoryContext,
  type MemoryEntry,
} from "./memory.ts";

/** The slice of IssueSource this module needs — narrowed so tests can pass a
 *  plain stub instead of a real gh-backed IssueSource. */
export interface MemoryIssueSource {
  findIssueByLabel(label: string): Promise<{ number: number } | null>;
  createIssue(opts: { title: string; body: string; labels: string[] }): Promise<number>;
  listComments(n: number): Promise<string[]>;
  comment(n: number, body: string): Promise<void>;
}

/** Retrieve this repo's memory, rendered for {{MEMORY_CONTEXT}} prompt substitution.
 *  Degrades to the "no prior memory" placeholder on any failure (no issue yet, gh blip). */
export async function readMemoryContext(issues: MemoryIssueSource): Promise<string> {
  try {
    const memoryIssue = await issues.findIssueByLabel(MEMORY_LABEL);
    if (!memoryIssue) return renderMemoryContext([]);

    const comments = await issues.listComments(memoryIssue.number);
    const entries = comments
      .map(parseMemoryComment)
      .filter((entry): entry is MemoryEntry => entry !== null);

    return renderMemoryContext(selectMemoryContext(entries));
  } catch (err) {
    console.warn("[memory] read failed — continuing without memory context:", err);
    return renderMemoryContext([]);
  }
}

/** Persist one memory entry, auto-creating the pinned memory issue on first write.
 *  Swallows any failure (missing issue, gh blip) — never blocks or retries the caller. */
export async function writeMemoryEntry(
  issues: MemoryIssueSource,
  entry: MemoryEntry,
): Promise<void> {
  try {
    let memoryIssue = await issues.findIssueByLabel(MEMORY_LABEL);
    if (!memoryIssue) {
      const number = await issues.createIssue({
        title: MEMORY_ISSUE_TITLE,
        body: MEMORY_ISSUE_BODY,
        labels: [MEMORY_LABEL],
      });
      memoryIssue = { number };
    }
    await issues.comment(memoryIssue.number, formatMemoryComment(entry));
  } catch (err) {
    console.warn(`[memory] write failed for category '${entry.category}' — continuing:`, err);
  }
}
