/**
 * Context compressor — headroom-ai integration for agentic-dev.
 *
 * Wraps headroom-ai's compress() to shrink compiled prompts before they reach the agent.
 * Controlled by HEADROOM_MODE env var — off by default for safe rollout. This module is
 * tier-agnostic; callers gate on tier themselves (sandbox-runner.ts skips invoking the
 * callback on the local/Ollama tier, which has no token cost to save).
 *
 * Works at the prompt text level (sandcastle doesn't expose structured messages), so
 * compression targets the template-resolved prompt + substituted args that form our
 * instructions to Claude Code. The compressed text replaces the original before
 * sandcastle passes it to the agent subprocess.
 */

/** Compression mode — off by default for safe rollout. */
export type HeadroomMode = "off" | "conservative" | "aggressive";

const HEADROOM_MODE: HeadroomMode =
  (process.env.HEADROOM_MODE as HeadroomMode) || "off";

const HEADROOM_MODEL = process.env.HEADROOM_MODEL || "claude-sonnet-4-6";

/** Current headroom mode (for tests and logging). */
export function getHeadroomMode(): HeadroomMode {
  return HEADROOM_MODE;
}

/** Resolve the compression callback, or undefined if disabled. */
export function getCompressionCallback() {
  if (HEADROOM_MODE === "off") return undefined;

  return async (prompt: string): Promise<string> => {
    const { compress } = await import("headroom-ai");
    const messages = [{ role: "user" as const, content: prompt }];
    const result = await compress(messages, { model: HEADROOM_MODEL });
    // CompressResult.messages is typed `any[]` (headroom preserves whatever
    // format was passed in) — validate the shape at runtime rather than
    // trusting it, so a proxy-side format drift degrades to uncompressed
    // passthrough loudly instead of silently.
    const content = result.messages[0]?.content;
    if (typeof content !== "string") {
      console.warn(
        `[context-compressor] unexpected compress() result shape (messages[0].content is ${typeof content}) — using uncompressed prompt`,
      );
      return prompt;
    }
    return content;
  };
}

/** Whether compression is active (for logging). */
export function isCompressionActive(): boolean {
  return HEADROOM_MODE !== "off";
}
