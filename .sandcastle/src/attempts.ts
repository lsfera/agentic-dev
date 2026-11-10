/**
 * Cross-run retry attempt persistence. Attempt counts used to live only in the
 * orchestrator's memory and reset on restart. They are now mirrored as hidden
 * marker comments on the issue itself (GitHub is the durable state), so a crash
 * mid-retry cannot grant a fresh `maxRetries` budget.
 *
 * Rule: count `ATTEMPT_FAILED_MARKER` comments posted AFTER the most recent
 * `RETRIES_EXHAUSTED_MARKER` comment. A human who re-labels an exhausted issue
 * therefore starts from zero, while an in-flight retry budget survives restarts.
 */
export const ATTEMPT_FAILED_MARKER = "<!-- agentic:attempt-failed -->";
export const RETRIES_EXHAUSTED_MARKER = "<!-- agentic:retries-exhausted -->";

/** Pure: prior failed attempts for an issue, from its comment bodies (oldest first). */
export function countPriorFailures(comments: readonly string[]): number {
  let count = 0;
  for (const body of comments) {
    if (body.includes(RETRIES_EXHAUSTED_MARKER)) count = 0;
    else if (body.includes(ATTEMPT_FAILED_MARKER)) count++;
  }
  return count;
}

export const attemptFailedComment = (attempt: number, max: number): string =>
  `${ATTEMPT_FAILED_MARKER}\nAgent attempt ${attempt}/${max} failed; re-queued for retry.`;

export const exhaustedComment = (body: string): string => `${body}\n\n${RETRIES_EXHAUSTED_MARKER}`;
