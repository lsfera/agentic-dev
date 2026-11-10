/**
 * Startup preflight for /afk (ADR-0020): auto-merge is only as safe as the
 * repo's required status checks. This module checks that the base branch
 * actually requires a status check (classic branch protection or a ruleset)
 * and reports a verdict. Pure assessment + a thin gh-backed reader.
 */
import { Effect } from "effect";
import type { ShellExec } from "./infra.ts";

export interface ProtectionInput {
  /** JSON of GET /branches/:b/protection, or null if 404 / unreadable. */
  readonly classic: unknown | null;
  /** JSON array of GET /rules/branches/:b, or null if unreadable. */
  readonly rules: unknown | null;
}

export interface ProtectionVerdict {
  readonly ok: boolean;
  readonly reason: string;
}

const hasChecks = (v: unknown): boolean => {
  if (!v || typeof v !== "object") return false;
  const rsc = (v as { required_status_checks?: unknown }).required_status_checks;
  if (!rsc || typeof rsc !== "object") return false;
  const r = rsc as { contexts?: unknown[]; checks?: unknown[] };
  return (r.contexts?.length ?? 0) + (r.checks?.length ?? 0) > 0;
};

/** Pure: does the base branch require at least one status check? */
export function assessProtection(input: ProtectionInput): ProtectionVerdict {
  if (hasChecks(input.classic)) {
    return { ok: true, reason: "branch protection requires status checks" };
  }
  if (
    Array.isArray(input.rules) &&
    input.rules.some((r) => (r as { type?: string })?.type === "required_status_checks")
  ) {
    return { ok: true, reason: "a ruleset requires status checks" };
  }
  if (input.classic === null && input.rules === null) {
    return { ok: false, reason: "could not read branch protection (missing permission or gh unavailable)" };
  }
  return { ok: false, reason: "no required status checks on the base branch" };
}

const readJson = (exec: ShellExec, args: string[]): Effect.Effect<unknown | null> =>
  Effect.tryPromise(async () => {
    const { stdout } = await exec("gh", ["api", ...args]);
    return JSON.parse(String(stdout)) as unknown;
  }).pipe(Effect.orElseSucceed(() => null));

/** Read protection state for `base` and assess it. Never fails. */
export const checkBranchProtection = (
  exec: ShellExec,
  base: string,
  repo?: string,
): Effect.Effect<ProtectionVerdict> =>
  Effect.gen(function* () {
    const root = repo ? `repos/${repo}` : "repos/{owner}/{repo}";
    const classic = yield* readJson(exec, [`${root}/branches/${base}/protection`]);
    const rules = yield* readJson(exec, [`${root}/rules/branches/${base}`]);
    return assessProtection({ classic, rules });
  });

/** Decide what to do with a failing verdict: refuse (strict) or warn. */
export function protectionAction(
  verdict: ProtectionVerdict,
  strict: boolean,
): "ok" | "warn" | "refuse" {
  if (verdict.ok) return "ok";
  return strict ? "refuse" : "warn";
}
