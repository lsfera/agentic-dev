/**
 * Retry `fn` up to `maxAttempts` times with exponential backoff.
 * Throws the last error when all attempts are exhausted, or immediately
 * (no further attempts) when `shouldRetry` returns false for a given error —
 * e.g. a session-limit or auth failure that retrying won't fix, vs. a
 * transient network blip that will likely clear on its own.
 * `sleep` is injectable for unit tests (no real network or timers needed).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    label?: string;
    sleep?: (ms: number) => Promise<void>;
    shouldRetry?: (err: unknown) => boolean;
  } = {},
): Promise<T> {
  const {
    maxAttempts = 4,
    baseDelayMs = 2_000,
    label = "operation",
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    shouldRetry = () => true,
  } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err)) {
        throw err;
      }
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        console.warn(
          `[retry] ${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}
