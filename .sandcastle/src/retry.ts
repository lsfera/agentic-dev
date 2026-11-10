/**
 * Retry with exponential backoff — Effect core (`retryEffect`) plus a Promise
 * facade (`withRetry`) for callers that have not moved to Effect yet.
 *
 * Retries up to `maxAttempts` total attempts. The last error is surfaced when
 * attempts are exhausted, or immediately (no further attempts) when
 * `shouldRetry` returns false — e.g. a session-limit or auth failure that
 * retrying won't fix, vs. a transient network blip that will likely clear.
 * `sleep` is injectable so unit tests need no real timers.
 */
import { Effect } from "effect";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  label?: string;
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (err: unknown) => boolean;
}

/** Retry an Effect whose failure channel carries the raw error. */
export function retryEffect<A, E, R>(
  op: Effect.Effect<A, E, R>,
  opts: RetryOptions = {},
): Effect.Effect<A, E, R> {
  const {
    maxAttempts = 4,
    baseDelayMs = 2_000,
    label = "operation",
    sleep,
    shouldRetry = () => true,
  } = opts;
  const pause = (ms: number) =>
    sleep ? Effect.promise(() => sleep(ms)) : Effect.sleep(ms);

  const attempt = (n: number): Effect.Effect<A, E, R> =>
    op.pipe(
      Effect.catch((err) => {
        if (!shouldRetry(err) || n >= maxAttempts) return Effect.fail(err);
        const delay = baseDelayMs * 2 ** (n - 1);
        return Effect.sync(() =>
          console.warn(
            `[retry] ${label} failed (attempt ${n}/${maxAttempts}), retrying in ${delay}ms`,
          ),
        ).pipe(
          Effect.andThen(pause(delay)),
          Effect.andThen(attempt(n + 1)),
        );
      }),
    );
  return attempt(1);
}

/** Promise facade over `retryEffect` — same contract as the original helper
 *  (rejects with the original error, unwrapped). */
export function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const op = Effect.tryPromise({ try: fn, catch: (e) => e });
  return Effect.runPromise(retryEffect(op, opts));
}
