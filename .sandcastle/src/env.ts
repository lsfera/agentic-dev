/** Environment/credential/run-mode helpers for the orchestrator. Extracted from main.ts; re-exported there for existing consumers. */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

/**
 * Parse dotenv-style content (KEY=VALUE, # comments, blank lines) into a
 * plain object. Supports only the simple KEY=VALUE syntax used by
 * orchestrator.env — no quoted strings, no variable expansion.
 * Pure: no I/O; accepts raw file content so callers can be tested without disk.
 */
export function parseOrchEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1);
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Decide the DOCKER_HOST the orchestrator's docker CLI should use, to dodge the
 * docker-outside-of-docker socat proxy.
 *
 * The DooD feature fixes socket permissions by fronting the host socket with
 * `socat UNIX-LISTEN:/var/run/docker.sock ... UNIX-CONNECT:/var/run/docker-host.sock`.
 * But socat tears down `docker exec`'s *hijacked* bidirectional stream after the
 * first data burst — and sandcastle streams the agent's stream-json over
 * `docker exec`. So the agent's init line arrives, then the rest of the turn is
 * dropped: every iteration is an empty "started → stopped" turn with zero commits
 * (the close handler's `code ?? 0` even masks it as a clean exit). The feature
 * also exposes the *real* host socket at docker-host.sock and adds the user to the
 * docker group, so pointing the CLI straight at it restores streaming.
 *
 * Guarded so it is a no-op outside the socat setup — returns undefined (leave
 * DOCKER_HOST as-is) when the caller already set one, or when the direct socket is
 * absent. A bare `docker compose up` (no DooD feature, no socat) has no
 * docker-host.sock and its raw /var/run/docker.sock works natively, so it must be
 * left untouched. Pure: the decision is returned, not applied, so it's testable
 * without env/fs side effects.
 */
export function resolveDockerHost(
  currentDockerHost: string | undefined,
  directSocketExists: boolean,
): string | undefined {
  if (currentDockerHost) return undefined; // an explicit choice always wins
  if (!directSocketExists) return undefined; // no socat proxy in the way
  return "unix:///var/run/docker-host.sock";
}

export interface ResolvedCredentials {
  readonly GH_TOKEN: string | undefined;
  readonly GITHUB_TOKEN: string | undefined;
  readonly ANTHROPIC_API_KEY: string | undefined;
  readonly CLAUDE_CODE_OAUTH_TOKEN: string | undefined;
  /** True when AGENTIC_IN_CONTAINER is set (cockpit mode). */
  readonly cockpit: boolean;
}

/**
 * Resolve agent credentials from the process env and parsed orchestrator.env
 * content, with process env taking precedence over orchestrator.env. Pure: no
 * disk I/O or process.env mutation — accepts both sources as plain objects.
 *
 * Precedence: a non-empty value in `env` wins; empty or absent values fall
 * through to `orchEnv`. The `cockpit` field reflects whether AGENTIC_IN_CONTAINER
 * is set in `env` (the marker baked into the devcontainer image, ADR-0018).
 */
export function resolveCredentials(
  env: Record<string, string | undefined>,
  orchEnv: Record<string, string | undefined> = {},
): ResolvedCredentials {
  const pick = (key: string): string | undefined => {
    const envVal = env[key];
    if (envVal !== undefined && envVal !== '') return envVal;
    const orchVal = orchEnv[key];
    return orchVal !== undefined && orchVal !== '' ? orchVal : undefined;
  };
  return {
    GH_TOKEN: pick('GH_TOKEN'),
    GITHUB_TOKEN: pick('GITHUB_TOKEN'),
    ANTHROPIC_API_KEY: pick('ANTHROPIC_API_KEY'),
    CLAUDE_CODE_OAUTH_TOKEN: pick('CLAUDE_CODE_OAUTH_TOKEN'),
    cockpit: Boolean(env['AGENTIC_IN_CONTAINER']),
  };
}

/**
 * Resolve how the orchestrator process should be launched. Pure function — no
 * I/O. Returns 'detached' when the cockpit marker is present (AGENTIC_IN_CONTAINER
 * is set to a non-empty value, baked into the devcontainer image by ADR-0018),
 * 'foreground' otherwise (host-driven mode, /exec runs the orchestrator directly).
 *
 * The launcher (run.sh) always execs `tsx main.ts`; this function is the sole
 * decision point so detachment logic lives in TypeScript, not in the shell.
 */
export function resolveRunMode(env: Record<string, string | undefined>): 'detached' | 'foreground' {
  return env['AGENTIC_IN_CONTAINER'] ? 'detached' : 'foreground';
}

/**
 * Relaunch the orchestrator as a detached background process inside the
 * container. Called when resolveRunMode() returns 'detached'. Spawns a new
 * tsx process with AGENTIC_IN_CONTAINER removed (so the child resolves
 * 'foreground' and runs the orchestrator loop normally), redirects stdio to a
 * timestamped log file under .sandcastle/logs/, saves the PID, prints
 * monitoring hints, and returns — the caller exits immediately after.
 */
export function detachAndRelaunch(mode: string): void {
  const cwd = process.cwd();
  const logsDir = join(cwd, '.sandcastle', 'logs');
  mkdirSync(logsDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = join(logsDir, `${mode}-${ts}.log`);
  const pidPath = join(cwd, '.sandcastle', `${mode}.pid`);

  const logFd = openSync(logPath, 'w');

  const tsxBin = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'tsx');
  const mainTs = fileURLToPath(import.meta.url);

  // Strip the cockpit marker so the child resolves 'foreground' and runs the
  // orchestrator loop directly without triggering another detach.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'AGENTIC_IN_CONTAINER') childEnv[k] = v;
  }

  const child = spawn(tsxBin, [mainTs], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: childEnv,
  });
  child.unref();
  closeSync(logFd);

  writeFileSync(pidPath, String(child.pid));
  console.log(`[cockpit] ${mode} started in background (PID ${child.pid})`);
  console.log(`[cockpit] log:  ${logPath}`);
  console.log(`[cockpit] tail: tail -f ${logPath}`);
  console.log(`[cockpit] stop: kill $(cat ${pidPath}) && rm ${pidPath}`);
}

/** Read the concurrency cap from AGENTIC_CONCURRENCY (default 1, serial). */
export function parseConcurrency(): number {
  return Math.max(1, Number(process.env.AGENTIC_CONCURRENCY ?? "1") || 1);
}

