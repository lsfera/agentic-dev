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

/** Current headroom mode — reads env var at call time so tests can set it after module load. */
export function getHeadroomMode(): HeadroomMode {
  return (process.env.HEADROOM_MODE as HeadroomMode) || "off";
}

/** Resolve the compression callback, or undefined if disabled. */
export function getCompressionCallback() {
  const mode = getHeadroomMode();
  if (mode === "off") return undefined;

  const model = process.env.HEADROOM_MODEL || "claude-sonnet-4-6";
  return async (prompt: string): Promise<string> => {
    const { compress } = await import("headroom-ai");
    const messages = [{ role: "user" as const, content: prompt }];
    const result = await compress(messages, { model });
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
    // Token savings measurement: log before/after char counts (~4 chars/token).
    const saved = prompt.length - content.length;
    const pct = ((saved / prompt.length) * 100).toFixed(1);
    console.log(
      `[context-compressor] mode=${mode} ${prompt.length}→${content.length} chars (−${saved}, −${pct}%)`,
    );
    return content;
  };
}

/** Whether compression is active (for proxy injection and logging). */
export function isCompressionActive(): boolean {
  return getHeadroomMode() !== "off";
}
