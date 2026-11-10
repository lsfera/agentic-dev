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
import { Effect } from "effect";
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
 *  plain stub instead of a real gh-backed IssueSource. Effect-native: this is
 *  exactly the shape IssueSource exposes. */
export interface MemoryIssueSource {
  findIssueByLabel(label: string): Effect.Effect<{ number: number } | null, unknown>;
  createIssue(opts: { title: string; body: string; labels: string[] }): Effect.Effect<number, unknown>;
  listComments(n: number): Effect.Effect<string[], unknown>;
  comment(n: number, body: string): Effect.Effect<void, unknown>;
}

/** Promise-flavoured variant of MemoryIssueSource, for non-Effect callers/stubs. */
export interface MemoryIssueSourcePromise {
  findIssueByLabel(label: string): Promise<{ number: number } | null>;
  createIssue(opts: { title: string; body: string; labels: string[] }): Promise<number>;
  listComments(n: number): Promise<string[]>;
  comment(n: number, body: string): Promise<void>;
}

/** Lift a Promise-flavoured source into the Effect-native shape. */
const liftIssues = (p: MemoryIssueSourcePromise): MemoryIssueSource => ({
  findIssueByLabel: (label) => Effect.tryPromise(() => p.findIssueByLabel(label)),
  createIssue: (opts) => Effect.tryPromise(() => p.createIssue(opts)),
  listComments: (n) => Effect.tryPromise(() => p.listComments(n)),
  comment: (n, body) => Effect.tryPromise(() => p.comment(n, body)),
});

const causeOf = (err: unknown): unknown =>
  err && typeof err === "object" && "cause" in err ? (err as { cause: unknown }).cause : err;

/** Retrieve this repo's memory, rendered for {{MEMORY_CONTEXT}} prompt substitution.
 *  Degrades to the "no prior memory" placeholder on any failure (no issue yet, gh blip). */
export const readMemoryContextEffect = (issues: MemoryIssueSource): Effect.Effect<string> =>
  Effect.gen(function* () {
    const memoryIssue = yield* issues.findIssueByLabel(MEMORY_LABEL);
    if (!memoryIssue) return renderMemoryContext([]);

    const comments = yield* issues.listComments(memoryIssue.number);
    const entries = comments
      .map(parseMemoryComment)
      .filter((entry): entry is MemoryEntry => entry !== null);

    return renderMemoryContext(selectMemoryContext(entries));
  }).pipe(
    Effect.catch((err) =>
      Effect.sync(() => {
        console.warn("[memory] read failed — continuing without memory context:", causeOf(err));
        return renderMemoryContext([]);
      }),
    ),
  );

/** Persist one memory entry, auto-creating the pinned memory issue on first write.
 *  Swallows any failure (missing issue, gh blip) — never blocks or retries the caller. */
export const writeMemoryEntryEffect = (
  issues: MemoryIssueSource,
  entry: MemoryEntry,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    let memoryIssue = yield* issues.findIssueByLabel(MEMORY_LABEL);
    if (!memoryIssue) {
      const number = yield* issues.createIssue({
        title: MEMORY_ISSUE_TITLE,
        body: MEMORY_ISSUE_BODY,
        labels: [MEMORY_LABEL],
      });
      memoryIssue = { number };
    }
    yield* issues.comment(memoryIssue.number, formatMemoryComment(entry));
  }).pipe(
    Effect.catch((err) =>
      Effect.sync(() =>
        console.warn(
          `[memory] write failed for category '${entry.category}' — continuing:`,
          causeOf(err),
        ),
      ),
    ),
  );

/** Promise facades — callers outside the Effect pipeline (and the test stubs). */
export const readMemoryContext = (issues: MemoryIssueSourcePromise): Promise<string> =>
  Effect.runPromise(readMemoryContextEffect(liftIssues(issues)));
export const writeMemoryEntry = (issues: MemoryIssueSourcePromise, entry: MemoryEntry): Promise<void> =>
  Effect.runPromise(writeMemoryEntryEffect(liftIssues(issues), entry));
