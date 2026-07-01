/**
 * Context compressor — headroom-ai integration for agentic-dev.
 *
 * Wraps headroom-ai's compress() to shrink compiled prompts before they reach the agent.
 * Only activates in Claude tier (local Ollama has no token cost). Controlled by
 * HEADROOM_MODE env var — off by default for safe rollout.
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
    const mod = await import("headroom-ai");
    const messages = [{ role: "user" as const, content: prompt }];
    const result = await mod.compress(messages, { model: HEADROOM_MODEL });
    // headroom returns a CompressResult with compressed messages array.
    // Cast to access the output — headroom's actual return shape is opaque without typing.
    const compressedMsgs = (result as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    return compressedMsgs[0]?.content ?? prompt;
  };
}

/** Whether compression is active (for logging). */
export function isCompressionActive(): boolean {
  return HEADROOM_MODE !== "off";
}
