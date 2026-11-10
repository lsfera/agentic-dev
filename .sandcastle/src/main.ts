/**
 * Orchestrator entrypoint — the engine `/afk` launches (replacing the old
 * host-sub-agent loop). It runs INSIDE the outer devcontainer, from the
 * path-matched host mount (`${LOCAL_WORKSPACE_FOLDER}`), so sandcastle's
 * git-isolated worktrees resolve under docker-outside-of-docker (ADR-0011).
 *
 * Event-driven operation (ADR-0008): a smee.io SSE channel relays GitHub
 * pull_request webhooks into the orchestrator as PrMerged events. The poll
 * loop is kept as a reconciliation backstop (5 min interval when smee is
 * active) so a missed delivery cannot stall the run.
 *
 * Env:
 *   AGENTIC_REPO          optional "owner/name" (default: cwd repo origin)
 *   AGENTIC_BASE_BRANCH   PR base branch (default: main)
 *   AGENTIC_MODEL         claudeCode model (default: claude-sonnet-4-6)
 *   SANDCASTLE_IMAGE      inner image (default: sandcastle:local)
 *   SANDCASTLE_CONTAINER_UID  inner image's non-root UID (default: 1000, sandcastle's
 *                             own default — only needed when a custom image renames its
 *                             user to a different UID, e.g. the dotnet SDK base's 1654)
 *   SANDCASTLE_CONTAINER_GID  matching GID (default: 1000)
 *   AGENTIC_CONCURRENCY   max parallel sandboxes (default: 1, serial)
 *   SMEE_URL              smee.io channel URL (enables event-driven mode)
 *   WEBHOOK_SECRET        shared HMAC secret for X-Hub-Signature-256 validation
 *
 * Concurrency note: raising AGENTIC_CONCURRENCY multiplies live resources —
 * N inner Docker sandboxes, N read-only SSH-key copies (ADR-0004), and
 * N concurrent Claude subscription seats. The safe default stays serial (1).
 */
import * as https from "node:https";
import * as http from "node:http";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { reduce, READY_LABEL, IN_PROGRESS_LABEL, IN_REVIEW_LABEL, reviewVerdict, reconcileFromLabels, type State, type Pr, type Policy, type Mode, type ReviewOutput, type ReviewVerdict } from "./reduce.ts";
import { IssueSource } from "./issue-source.ts";
import { SandboxRunner, SANDBOX_LABEL, PROJECT_LABEL_KEY, deriveProject } from "./sandbox-runner.ts";
import { ReviewerAdapter } from "./reviewer-adapter.ts";
import { readMemoryContextEffect, writeMemoryEntryEffect } from "./memory-store.ts";
import { parseMemoryTags, buildOutcomeEntry, type OutcomeAttempt } from "./memory.ts";
import { Effect, Fiber, Layer } from "effect";
import { Mac, SecureRandom } from "effect/crypto";
import { GhError, ShellError, SandboxError } from "./errors.ts";
import { withRetry, retryEffect } from "./retry.ts";
export { withRetry };

export { SANDBOX_LABEL };

const sh = promisify(execFile);

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
function detachAndRelaunch(mode: string): void {
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

// withRetry lives in retry.ts (shared with sandbox-runner.ts, which main.ts
// itself imports — keeping it there avoids a circular import). Imported and
// re-exported at the top of this file for existing consumers.

type ShellExec = (file: string, args: string[]) => Promise<{ stdout: string | Buffer }>;

type GitRun = (args: string[]) => Promise<unknown>;

/** Lift a Promise-returning shell seam into a typed Effect. */
const shell = (exec: ShellExec, file: string, args: string[]) =>
  Effect.tryPromise({
    try: () => exec(file, args),
    catch: (cause) => new ShellError({ command: `${file} ${args.join(" ")}`, cause }),
  });

/** The underlying error behind a typed wrapper, for log output. */
const causeOf = (err: unknown): unknown =>
  err && typeof err === "object" && "cause" in err && (err as { cause?: unknown }).cause !== undefined
    ? (err as { cause: unknown }).cause
    : err;

/** A human-readable one-liner for a failure (stored in the memory entry). */
const noteOf = (err: unknown): string => {
  const c = causeOf(err);
  return c instanceof Error ? c.message : String(c);
};

/** Log-and-continue: turn any failure of `eff` into a console.error. */
const orLog =
  (message: string) =>
  <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    eff.pipe(
      Effect.asVoid,
      Effect.catch((err) => Effect.sync(() => console.error(message, causeOf(err)))),
    );

/**
 * Delete the stale local and remote `agent/issue-N` branch before starting a
 * new sandbox. Best-effort — both deletions silently succeed if the branch is
 * absent. Accepts an injectable gitRun for unit testing (#23).
 */
export const resetAgentBranchEffect = (issueId: number, gitRun: GitRun): Effect.Effect<void> => {
  const branch = `agent/issue-${issueId}`;
  const git = (args: string[]) => Effect.tryPromise(() => gitRun(args)).pipe(Effect.ignore);
  return git(["branch", "-D", branch]).pipe(
    Effect.andThen(git(["push", "origin", "--delete", branch])),
  );
};

/**
 * Refresh the local base branch to match the remote before a sandbox branch is
 * cut from it. The orchestrator branches each `agent/issue-N` off the host's
 * *local* base; if local base is stale (not pulled after an earlier PR merged),
 * the new branch is based on an old commit and its PR conflicts at merge time
 * (#28 — bit the #15 and #23 runs). Fetch + hard-reset the local base to
 * `origin/<base>` so every sandbox branches from current origin.
 *
 * Best-effort and non-fatal: the fetch is retried and any failure is logged
 * but swallowed — a refresh failure must not crash the run; the sandbox
 * proceeds from whatever base exists. Complements resetAgentBranch (#23): that
 * deletes the stale *branch*, this refreshes the *base*. Injectable gitRun +
 * sleep for unit testing.
 */
export const refreshBaseEffect = (
  base: string,
  gitRun: GitRun,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Effect.Effect<void> => {
  const git = (args: string[]) => Effect.tryPromise({ try: () => gitRun(args), catch: (e) => e });
  return retryEffect(git(["fetch", "origin", base]), {
    label: `fetch origin ${base}`,
    sleep: opts.sleep,
  }).pipe(
    Effect.andThen(git(["checkout", base])),
    Effect.andThen(git(["reset", "--hard", `origin/${base}`])),
    Effect.asVoid,
    Effect.catch((err) =>
      Effect.sync(() =>
        console.warn(
          `[base-refresh] could not refresh '${base}' from origin ` +
            `(continuing on existing base):`,
          err,
        ),
      ),
    ),
  );
};

/**
 * Remove orphaned containers that carry the agentic sandbox label.
 *
 * Called on startup (sweeps orphans from a previous crashed run) and at the
 * end of main() (confirms no containers linger after a clean exit). Each
 * sandbox is an acquire/release resource that closes on completion or
 * interruption; this sweep is a belt-and-suspenders backstop for the
 * SIGKILL / OOM case where those finalizers never fire.
 *
 * When `project` is given the sweep is scoped to that project (#40): a
 * container is removed only if its `agentic.sandbox.project` label matches —
 * or is empty (a legacy image built before the label existed, treated as
 * unowned). Containers labelled for a *different* project are left untouched,
 * so once multiple projects run concurrently one project's sweep never
 * force-removes another's in-flight sandboxes. Omitting `project` keeps the
 * original behaviour (sweep every agentic sandbox).
 *
 * Accepts an optional exec shim for unit testing.
 */
export const sweepOrphanedSandboxesEffect = (
  exec: ShellExec = sh as ShellExec,
  project?: string,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const { stdout } = yield* shell(exec, "docker", [
      "ps", "-a", "--no-trunc",
      "--filter", `label=${SANDBOX_LABEL}`,
      "--format", `{{.ID}}\t{{.Label "${PROJECT_LABEL_KEY}"}}`,
    ]);
    const ids = String(stdout)
      .split("\n")
      .map((line) => {
        const [id, labelProject = ""] = line.split("\t");
        return { id: id.trim(), labelProject: labelProject.trim() };
      })
      .filter(({ id }) => id.length > 0)
      // Scope to this project: keep own-project containers and legacy/unowned
      // (empty-label) ones; never touch another project's containers.
      .filter(({ labelProject }) => !project || labelProject === "" || labelProject === project)
      .map(({ id }) => id);
    if (ids.length === 0) return 0;
    yield* shell(exec, "docker", ["rm", "-f", ...ids]);
    console.log(
      `[afk] swept ${ids.length} orphaned sandbox container(s)` +
        (project ? ` for project '${project}'` : ""),
    );
    return ids.length;
  }).pipe(Effect.orElseSucceed(() => 0));

/** Default inner-sandbox network name and MTU (#48). */
export const SANDBOX_NETWORK = process.env.AGENTIC_SANDBOX_NETWORK ?? "agentic-sandbox-net";
export const SANDBOX_MTU = process.env.AGENTIC_SANDBOX_MTU ?? "1400";

/**
 * Ensure a Docker network with a path-correct MTU exists for inner sandboxes (#48).
 *
 * Docker Desktop's default bridge advertises MTU 65535 while the real
 * container→host→internet path is ~1400 bytes; with PMTUD black-holed, small
 * requests pass but the agent's *streaming* responses (Anthropic API for the
 * claude tier, host Ollama for the local tier) stall after the first chunk, so
 * every iteration is an empty "Agent started → Agent stopped" turn. Attaching
 * the inner container to an MTU-1400 network fixes both tiers (verified: a 10 MB
 * download and a full claude turn both complete on MTU 1400 but stall at 1500/
 * 65535). `host.docker.internal` still resolves on this network, so the local
 * tier keeps reaching Ollama.
 *
 * Idempotent: creates the network only if missing. Best-effort — a failure here
 * (e.g. it already exists with a different driver) is logged, not fatal; the run
 * falls back to the default network. Accepts an exec shim for unit testing.
 */
export const ensureSandboxNetworkEffect = (
  name: string = SANDBOX_NETWORK,
  mtu: string = SANDBOX_MTU,
  exec: ShellExec = sh as ShellExec,
): Effect.Effect<boolean> =>
  shell(exec, "docker", ["network", "inspect", name]).pipe(
    Effect.as(true), // already exists
    Effect.catch(() =>
      // not present — create it
      shell(exec, "docker", [
        "network", "create",
        "--opt", `com.docker.network.driver.mtu=${mtu}`,
        name,
      ]).pipe(
        Effect.tap(() => Effect.sync(() => console.log(`[afk] created sandbox network '${name}' (mtu ${mtu})`))),
        Effect.as(true),
        Effect.catch((err) =>
          Effect.sync(() => {
            console.warn(
              `[afk] could not create sandbox network '${name}' (continuing on default network):`,
              causeOf(err),
            );
            return false;
          }),
        ),
      ),
    ),
  );

/**
 * Idempotently ensure the two durable lifecycle labels exist in the GitHub repo
 * (ADR-0021). Uses `--force` so the call is safe to repeat on every boot.
 * Best-effort — any failure is logged and swallowed; the run continues.
 */
const ensureLifecycleLabels = (repo?: string): Effect.Effect<void> => {
  const repoFlag = repo ? ["-R", repo] : [];
  const labels: Array<{ name: string; color: string; description: string }> = [
    { name: IN_PROGRESS_LABEL, color: "0075ca", description: "Sandbox is actively implementing this issue" },
    { name: IN_REVIEW_LABEL, color: "e4e669", description: "AI reviewer is running on the open PR" },
  ];
  return Effect.forEach(
    labels,
    ({ name, color, description }) =>
      shell(sh as ShellExec, "gh", [
        ...repoFlag,
        "label", "create", name,
        "--color", color,
        "--description", description,
        "--force",
      ]).pipe(Effect.ignore), // Label may already exist or gh may be unavailable — not fatal.
    { discard: true },
  );
};

/** Promise facades — the stable, test-facing API over the Effect cores above. */
export const resetAgentBranch = (issueId: number, gitRun: GitRun): Promise<void> =>
  Effect.runPromise(resetAgentBranchEffect(issueId, gitRun));
export const refreshBase = (
  base: string,
  gitRun: GitRun,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> => Effect.runPromise(refreshBaseEffect(base, gitRun, opts));
export const sweepOrphanedSandboxes = (exec?: ShellExec, project?: string): Promise<number> =>
  Effect.runPromise(sweepOrphanedSandboxesEffect(exec, project));
export const ensureSandboxNetwork = (name?: string, mtu?: string, exec?: ShellExec): Promise<boolean> =>
  Effect.runPromise(ensureSandboxNetworkEffect(name, mtu, exec));

/** Web-Crypto-backed HMAC service (Effect's crypto module). */
const MacLive = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto));

const SIGNATURE_RE = /^sha256=([0-9a-fA-F]{64})$/;

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

/**
 * Constant-time HMAC-SHA256 validation for GitHub webhook signatures.
 * `signature` is the raw X-Hub-Signature-256 header value (`sha256=<hex>`).
 * Malformed signatures (wrong prefix/length/non-hex) are simply `false`, as is
 * any crypto failure — the result is advisory (see classifyDelivery).
 */
export const validateSignatureEffect = (
  secret: string,
  rawBody: string,
  signature: string,
): Effect.Effect<boolean> => {
  const match = SIGNATURE_RE.exec(signature);
  if (!match) return Effect.succeed(false);
  const encoder = new TextEncoder();
  return Effect.gen(function* () {
    const mac = yield* Mac.Mac;
    const key = yield* Mac.key(Mac.hmacSha256, encoder.encode(secret));
    return yield* mac.verify(key, hexToBytes(match[1]), encoder.encode(rawBody));
  }).pipe(Effect.provide(MacLive), Effect.orElseSucceed(() => false));
};

export const validateSignature = (secret: string, rawBody: string, signature: string): Promise<boolean> =>
  Effect.runPromise(validateSignatureEffect(secret, rawBody, signature));

/** Outcome of checking a smee-relayed delivery's signature (#26). */
export type SignatureVerdict = "verified" | "mismatch" | "missing-signature" | "no-secret";

/**
 * Advisory signature check for a smee-relayed webhook delivery.
 *
 * AUTH MODEL (#26): the unguessable smee channel URL is the real trust boundary,
 * NOT the HMAC. smee re-parses and re-serializes the request body before
 * relaying it, so the raw bytes GitHub signed are gone by the time we see it.
 * Re-stringifying the parsed body reproduces GitHub's exact bytes for *most*
 * payloads, but not all: e.g. JSON numbers are reformatted (`1.0`→`1`, `5e2`→
 * `500`), which makes a strict HMAC reject a perfectly genuine delivery. We
 * therefore compute the verdict for observability but NEVER hard-reject on it —
 * the caller logs and proceeds. (To restore strict HMAC as a gate, put a
 * raw-body-preserving relay in front of the orchestrator instead of smee.)
 */
export const classifyDeliveryEffect = (
  secret: string | undefined,
  reserializedBody: string,
  signature: string | undefined,
): Effect.Effect<SignatureVerdict> => {
  if (!secret) return Effect.succeed("no-secret");
  if (!signature) return Effect.succeed("missing-signature");
  return validateSignatureEffect(secret, reserializedBody, signature).pipe(
    Effect.map((ok): SignatureVerdict => (ok ? "verified" : "mismatch")),
  );
};

export const classifyDelivery = (
  secret: string | undefined,
  reserializedBody: string,
  signature: string | undefined,
): Promise<SignatureVerdict> => Effect.runPromise(classifyDeliveryEffect(secret, reserializedBody, signature));

type SmeeHandler = (
  body: unknown,
  headers: Record<string, string>,
  deliveryId: string,
) => void | Promise<void>;

export interface SmeeEvent {
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly deliveryId: string;
}

/**
 * Parse one smee.io SSE `data:` JSON payload into body + normalized headers.
 *
 * smee flattens the original webhook headers to the TOP LEVEL of the payload,
 * alongside `body` (and its own `query`/`timestamp` fields) — it does NOT nest
 * them under a `headers` key. Reading headers from a `headers` sub-object
 * therefore finds nothing, so the listener's `x-github-event` check never
 * matches and every delivery is silently dropped — only the reconcile poll
 * fires. Confirmed against a live GitHub→smee delivery (#26).
 *
 * Both shapes are supported: a nested `headers` object when present (some
 * relays), otherwise every top-level key except smee's wrapper fields is taken
 * as a header. Keys are lowercased; array values take the first element.
 */
export function parseSmeeEvent(rawData: string): SmeeEvent {
  const parsed = JSON.parse(rawData) as Record<string, unknown>;
  const body = parsed["body"] ?? parsed;

  const WRAPPER_KEYS = new Set(["body", "query", "timestamp"]);
  const nested = parsed["headers"];
  const rawHdrs: Record<string, unknown> =
    nested && typeof nested === "object"
      ? (nested as Record<string, unknown>)
      : Object.fromEntries(Object.entries(parsed).filter(([k]) => !WRAPPER_KEYS.has(k)));

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHdrs)) {
    headers[k.toLowerCase()] = Array.isArray(v) ? String((v as unknown[])[0]) : String(v);
  }
  return { body, headers, deliveryId: headers["x-github-delivery"] ?? "" };
}

/**
 * Subscribe to a smee.io (or compatible) SSE channel and invoke the handler
 * on each webhook delivery. Reconnects automatically on disconnect.
 *
 * The caller is responsible for HMAC de-dupe; this function only parses the
 * SSE stream and validates the signature when `secret` is provided.
 */
export function startSmeeListener(
  smeeUrl: string,
  secret: string | undefined,
  handler: SmeeHandler,
): void {
  const connect = () => {
    const lib = smeeUrl.startsWith("https://") ? https : (http as unknown as typeof https);
    const req = lib.get(
      smeeUrl,
      {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
      (res) => {
        console.log(`[smee] connected (HTTP ${res.statusCode})`);
        let buf = "";
        let dataLines: string[] = [];
        let eventType = "message";

        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.length > 5 && line[5] === " " ? line.slice(6) : line.slice(5));
            } else if (line.trim() === "") {
              if (dataLines.length > 0 && eventType === "message") {
                const rawData = dataLines.join("\n");
                try {
                  const { body, headers, deliveryId } = parseSmeeEvent(rawData);

                  // Advisory signature check only — the secret channel URL is
                  // the trust boundary; smee's body re-serialization means a
                  // strict HMAC would drop genuine deliveries (#26). Log the
                  // verdict, never reject on it.
                  void Effect.runPromise(
                    classifyDeliveryEffect(secret, JSON.stringify(body), headers["x-hub-signature-256"]),
                  ).then((verdict) => {
                    if (verdict === "mismatch") {
                      console.warn(
                        "[smee] HMAC mismatch — likely smee body re-serialization, " +
                          "not forgery; processing anyway (channel URL is the trust boundary, #26)",
                      );
                    } else if (verdict === "missing-signature") {
                      console.warn(
                        "[smee] no X-Hub-Signature-256 header; processing anyway " +
                          "(channel URL is the trust boundary, #26)",
                      );
                    }
                  });

                  void handler(body, headers, deliveryId);
                } catch (e) {
                  console.error("[smee] failed to parse event:", e);
                }
              }
              dataLines = [];
              eventType = "message";
            }
          }
        });

        res.on("end", () => {
          console.log("[smee] connection closed — reconnecting in 5s");
          setTimeout(connect, 5_000);
        });

        res.on("error", (err: Error) => {
          console.error(`[smee] stream error: ${err.message}`);
          setTimeout(connect, 5_000);
        });
      },
    );

    req.on("error", (err: Error) => {
      console.error(`[smee] connection error: ${err.message}`);
      setTimeout(connect, 5_000);
    });

    req.setTimeout(0);
  };

  console.log(`[smee] connecting to ${smeeUrl}`);
  connect();
}

const main: Effect.Effect<void, GhError | ShellError> = Effect.gen(function* () {
  const mode = (process.env.AGENTIC_MODE ?? "afk") as Mode;

  if (resolveRunMode(process.env) === 'detached') {
    detachAndRelaunch(mode);
    return;
  }

  // Dodge the docker-outside-of-docker socat proxy (see resolveDockerHost): socat
  // breaks docker exec's streamed output, which sandcastle relies on for the agent
  // turn — without this every iteration is an empty turn. No-op when socat isn't in
  // play (bare `docker compose up`, or an explicit DOCKER_HOST). Must run before any
  // docker call below.
  const dockerHost = resolveDockerHost(
    process.env.DOCKER_HOST,
    existsSync("/var/run/docker-host.sock"),
  );
  if (dockerHost) process.env.DOCKER_HOST = dockerHost;

  const repo = process.env.AGENTIC_REPO;
  const base = process.env.AGENTIC_BASE_BRANCH ?? "main";
  const repoRoot = process.cwd();
  // Project identity scopes the orphan sweep so concurrent projects don't reap
  // each other's in-flight sandboxes (#40).
  const project = deriveProject(repo, repoRoot);

  // Startup sweep: remove this project's orphaned containers from any previous
  // crashed run.
  yield* sweepOrphanedSandboxesEffect(sh as ShellExec, project);

  // Ensure the durable lifecycle labels exist (ADR-0021). Best-effort — a failure
  // does not block the run; labels are only missing on first run or if deleted.
  yield* ensureLifecycleLabels(repo);

  // Ensure the MTU-corrected sandbox network exists so the agent's streaming
  // responses don't stall on Docker Desktop's oversized default-bridge MTU (#48).
  const networkReady = yield* ensureSandboxNetworkEffect();
  const network = networkReady ? SANDBOX_NETWORK : undefined;

  const issues = new IssueSource(repo);
  const tier = (process.env.AGENTIC_TIER ?? "claude") as "claude" | "local";
  const containerUid = process.env.SANDCASTLE_CONTAINER_UID
    ? Number(process.env.SANDCASTLE_CONTAINER_UID)
    : undefined;
  const containerGid = process.env.SANDCASTLE_CONTAINER_GID
    ? Number(process.env.SANDCASTLE_CONTAINER_GID)
    : undefined;
  const runner = new SandboxRunner({
    imageName: process.env.SANDCASTLE_IMAGE,
    model: process.env.AGENTIC_MODEL,
    tier,
    localModel: process.env.AGENTIC_LOCAL_MODEL,
    localImageName: process.env.SANDCASTLE_OPENCODE_IMAGE,
    cwd: repoRoot,
    network,
    containerUid,
    containerGid,
  });

  const reviewer = new ReviewerAdapter({
    model: process.env.AGENTIC_MODEL,
    cwd: repoRoot,
    baseBranch: base,
  });

  // In-process scheduling state. Plain mutable structures on purpose: the
  // reducer reads `inFlight` by reference, and the "check + add before the
  // first suspension" dedupe below relies on fibers running synchronously
  // until their first async step.
  const inFlight: number[] = [];
  // Per-issue count of SandboxFailed events dispatched this run. Persists
  // across ticks so the retry cap is enforced within a single orchestrator run.
  const failedAttempts: Record<number, number> = {};
  // Per-issue attempt history this run, accumulated across retries — flattened
  // into a single outcome memory entry at terminal state (ADR-0022).
  const attemptHistory: Record<number, OutcomeAttempt[]> = {};
  // Issue ids whose PrMerged event has been dispatched to the reducer.
  const seenMerges = new Set<number>();
  // GitHub X-GitHub-Delivery ids seen via smee — coarse delivery-level de-dupe.
  const seenDeliveries = new Set<string>();
  // Background fibers (per-issue workers, boot-time re-reviews). Awaited before
  // a clean exit so no in-progress work is cut short.
  const background = new Set<Fiber.Fiber<void, never>>();
  const track = (fiber: Fiber.Fiber<void, never>) => {
    background.add(fiber);
    fiber.addObserver(() => { background.delete(fiber); });
    return fiber;
  };

  const policy: Policy = { concurrency: parseConcurrency(), mode };

  /** gh call with the standard transient-failure backoff. */
  const gh = <A>(label: string, eff: Effect.Effect<A, GhError>) => retryEffect(eff, { label });
  const addLabel = (n: number, label: string) => gh(`addLabel #${n}`, issues.addLabel(n, label));

  // Dispatch a PrMerged event and execute the resulting Relabel actions.
  // Shared between the smee listener and the reconciliation poll; the
  // synchronous seenMerges check prevents double-dispatch.
  const handlePrMerged = (pr: Pr, source: string): Effect.Effect<void, GhError> =>
    Effect.gen(function* () {
      if (seenMerges.has(pr.issue)) return;
      seenMerges.add(pr.issue); // must stay before the first suspension

      console.log(`[${mode}] PR for #${pr.issue} merged (${source}) — checking dependents`);
      const allIssues = yield* gh("listAll", issues.listAll());
      const mergedPrsNow = yield* gh("listMergedPrs", issues.listMergedPrs());
      const openPrsNow = yield* gh("listOpenPrs", issues.listOpenPrs());
      const allPrsNow = [...mergedPrsNow, ...openPrsNow];

      const unblockState: State = { issues: allIssues, prs: allPrsNow, inFlight, policy };
      const unblockActions = reduce(unblockState, { type: "PrMerged", pr });
      for (const action of unblockActions) {
        if (action.type === "Relabel") {
          console.log(`[${mode}] #${pr.issue} merged → relabelling #${action.issueId} as ${action.label}`);
          yield* addLabel(action.issueId, action.label);
        }
      }
    });

  // Run the read-only AI review for #n's PR. Fail-safe: any reviewer or gh
  // failure → changes-requested, so a crash can never auto-merge.
  const reviewPr = (n: number, logPrefix: string) =>
    Effect.gen(function* () {
      const ghIssue = yield* issues.get(n);
      const diff = yield* issues.getPrDiff(n);
      return yield* reviewer.runReview(
        {
          issueNumber: n,
          issueTitle: ghIssue.title,
          issueBody: ghIssue.body,
          branch: `agent/issue-${n}`,
          prNumber: n,
        },
        diff,
      );
    }).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          console.warn(`${logPrefix} reviewer failed — defaulting to changes-requested:`, causeOf(err));
          return { verdict: reviewVerdict(null), output: null as ReviewOutput | null };
        }),
      ),
    );

  // Execute the reducer's follow-up actions for a finished review.
  const applyReviewActions = (
    actions: ReturnType<typeof reduce>,
    n: number,
    reviewOutput: ReviewOutput | null,
    logPrefix: string,
    onAutoMerge: Effect.Effect<void> = Effect.void,
  ) =>
    Effect.forEach(
      actions,
      (ra) => {
        switch (ra.type) {
          case "RemoveLabel":
            return issues.removeLabel(ra.issueId, ra.label).pipe(
              orLog(`${logPrefix} could not remove label ${ra.label}:`),
            );
          case "EnableAutoMerge":
            return Effect.sync(() => console.log(`${logPrefix} review passed → enabling auto-merge`)).pipe(
              Effect.andThen(issues.enableAutoMerge(ra.pr.issue).pipe(orLog(`${logPrefix} could not enable auto-merge:`))),
              // Terminal state (review passed — see ADR-0022 for why this,
              // not the later async PrMerged, is treated as the success point).
              Effect.andThen(onAutoMerge),
            );
          case "WaitForHuman":
            return Effect.sync(() => console.log(`${logPrefix} review requested changes → parked for human`)).pipe(
              Effect.andThen(
                reviewOutput
                  ? issues.postPrReview(n, reviewOutput).pipe(orLog(`${logPrefix} could not post PR review:`))
                  : Effect.void,
              ),
            );
          default:
            return Effect.void;
        }
      },
      { discard: true },
    );

  // Start the smee webhook listener if SMEE_URL is configured (ADR-0008).
  // The reconciliation poll below acts as the backstop for missed deliveries.
  const smeeUrl = process.env.SMEE_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (smeeUrl) {
    // The listener is a callback API; each delivery is run as its own fiber.
    startSmeeListener(smeeUrl, webhookSecret, async (body, headers, deliveryId) => {
      if (deliveryId && seenDeliveries.has(deliveryId)) return;
      if (deliveryId) seenDeliveries.add(deliveryId);

      if (headers["x-github-event"] !== "pull_request") return;

      type PrPayload = {
        action?: string;
        pull_request?: {
          merged?: boolean;
          head?: { ref?: string };
          merge_commit_sha?: string;
        };
      };
      const payload = body as PrPayload;
      if (payload.action !== "closed" || !payload.pull_request?.merged) return;

      const branch = payload.pull_request.head?.ref ?? "";
      const issueMatch = branch.match(/^agent\/issue-(\d+)$/);
      if (!issueMatch) return;

      const issueId = Number(issueMatch[1]);
      const mergeSha = payload.pull_request.merge_commit_sha ?? "";
      console.log(`[smee] PR merge: issue #${issueId} branch=${branch} sha=${mergeSha.slice(0, 7)}`);

      await Effect.runPromise(
        handlePrMerged({ issue: issueId, ciStatus: "success", merged: true }, `smee:${deliveryId}`).pipe(
          orLog(`[smee] handlePrMerged #${issueId} failed:`),
        ),
      );
    });
  }

  // With smee handling real-time merges, the poll loop is a reconciliation
  // backstop only; 5 min is sufficient. Without smee, keep the original 60s.
  const RECONCILE_INTERVAL = smeeUrl ? 5 * 60_000 : 60_000;

  // Boot reconcile (ADR-0021): read labels from a crashed predecessor and recover
  // in-flight work. Labels are written at each transition and read ONLY here at
  // startup; State.inFlight is the runtime source of truth thereafter.
  {
    const fetched = yield* Effect.all([
      gh("listAll (boot reconcile)", issues.listAll()),
      gh("listOpenPrs (boot reconcile)", issues.listOpenPrs()),
    ]).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          console.warn(`[${mode}] boot reconcile: could not fetch state — skipping:`, causeOf(err));
          return [[], []] as [import("./reduce.ts").Issue[], Pr[]];
        }),
      ),
    );
    const [bootIssues, bootOpenPrs] = fetched;
    const bootActions = reconcileFromLabels(bootIssues, bootOpenPrs);
    if (bootActions.length > 0) {
      console.log(`[${mode}] boot reconcile: ${bootActions.length} action(s) from crashed predecessor`);
    }
    for (const action of bootActions) {
      if (action.type === "RemoveLabel") {
        yield* issues.removeLabel(action.issueId, action.label).pipe(
          Effect.andThen(Effect.sync(() => console.log(`[${mode}] boot reconcile: #${action.issueId} removed label ${action.label}`))),
          orLog(`[${mode}] boot reconcile: could not remove label ${action.label} from #${action.issueId}:`),
        );
      }
      if (action.type === "Relabel") {
        yield* addLabel(action.issueId, action.label).pipe(
          Effect.andThen(Effect.sync(() => console.log(`[${mode}] boot reconcile: #${action.issueId} relabelled as ${action.label}`))),
          orLog(`[${mode}] boot reconcile: could not relabel #${action.issueId}:`),
        );
      }
      if (action.type === "StartReview") {
        // Re-run the read-only AI review on the existing PR (idempotent).
        // Runs in the background so startup is not blocked.
        const pr = action.pr;
        const n = pr.issue;
        const prefix = `[${mode}] boot reconcile: #${n}`;
        console.log(`${prefix} agent:in-review + open PR — re-running AI review`);
        const rereview = Effect.gen(function* () {
          const { verdict, output } = yield* reviewPr(n, prefix);
          console.log(`${prefix} review verdict: ${verdict}`);
          const reconcileState: State = { issues: bootIssues, prs: bootOpenPrs, inFlight, policy };
          const followUps = reduce(reconcileState, { type: "ReviewFinished", issue: n, pr, verdict });
          yield* applyReviewActions(followUps, n, output, prefix);
        });
        track(yield* Effect.forkChild(rereview));
      }
    }
  }

  // Everything one claimed issue goes through once its sandbox is launched:
  // run → record attempt → apply failure/finish transitions (+ AI review).
  const handleIssue = (
    n: number,
    snapshot: { ready: import("./reduce.ts").Issue[]; allPrs: Pr[] },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const result = yield* processIssue(n, issues, runner, base, repoRoot, mode).pipe(
        Effect.map((pr) =>
          pr === null
            ? ({ openedPr: null, failed: true, note: "sandbox produced no commits" } as const)
            : ({ openedPr: pr, failed: false, note: undefined } as const),
        ),
        Effect.tap((r) =>
          r.failed ? Effect.sync(() => console.log(`[${mode}] #${n} sandbox produced no commits`)) : Effect.void,
        ),
        Effect.catch((err) =>
          Effect.sync(() => {
            console.error(`[${mode}] #${n} failed:`, causeOf(err));
            return { openedPr: null, failed: true, note: noteOf(err) } as const;
          }),
        ),
        Effect.ensuring(Effect.sync(() => { inFlight.splice(inFlight.indexOf(n), 1); })),
      );
      const { openedPr, failed: sandboxFailed, note: failureNote } = result;
      const { ready, allPrs } = snapshot;

      // Record this attempt (ADR-0022) — flattened into a single outcome
      // memory entry when the issue reaches terminal state below.
      const history = attemptHistory[n] ?? (attemptHistory[n] = []);
      history.push({ succeeded: !sandboxFailed, note: sandboxFailed ? failureNote : undefined });

      if (sandboxFailed) {
        const attempts = failedAttempts[n] ?? 0;
        const failState: State = { issues: ready, prs: allPrs, inFlight, policy, failedAttempts };
        const failActions = reduce(failState, { type: "SandboxFailed", issue: n });
        failedAttempts[n] = attempts + 1;
        for (const action of failActions) {
          if (action.type === "RemoveLabel") {
            yield* issues.removeLabel(action.issueId, action.label).pipe(
              orLog(`[${mode}] #${n} could not remove label ${action.label}:`),
            );
          }
          if (action.type === "Relabel") {
            console.log(
              `[${mode}] #${n} failed — re-queuing for retry ` +
                `(${attempts + 1}/${policy.maxRetries ?? 2})`,
            );
            yield* addLabel(n, action.label).pipe(orLog(`[${mode}] #${n} could not re-queue:`));
          }
          if (action.type === "Comment") {
            console.log(`[${mode}] #${n} retries exhausted after ${attempts + 1} failures`);
            yield* issues.comment(n, action.body).pipe(
              orLog(`[${mode}] #${n} could not post exhaustion comment:`),
            );
            // Terminal state (retries exhausted) — persist the outcome (ADR-0022).
            yield* writeMemoryEntryEffect(issues, buildOutcomeEntry({ issueNumber: n, attempts: history }));
          }
        }
      }

      if (openedPr) {
        const finishState: State = {
          issues: ready,
          prs: [...allPrs, openedPr],
          inFlight,
          policy,
        };
        const finishActions = reduce(finishState, { type: "SandboxFinished", issue: n, pr: openedPr });
        const prefix = `[${mode}] #${n}`;
        for (const action of finishActions) {
          if (action.type === "RemoveLabel") {
            yield* issues.removeLabel(action.issueId, action.label).pipe(
              orLog(`${prefix} could not remove label ${action.label}:`),
            );
          }
          if (action.type === "Relabel") {
            yield* addLabel(action.issueId, action.label).pipe(
              orLog(`${prefix} could not add label ${action.label}:`),
            );
          }
          if (action.type === "StartReview") {
            console.log(`${prefix} → running AI review`);
            const { verdict, output } = yield* reviewPr(n, prefix);
            console.log(`${prefix} review verdict: ${verdict}`);
            const reviewActions = reduce(finishState, {
              type: "ReviewFinished",
              issue: n,
              pr: action.pr,
              verdict,
            });
            yield* applyReviewActions(
              reviewActions,
              n,
              output,
              prefix,
              writeMemoryEntryEffect(
                issues,
                buildOutcomeEntry({ issueNumber: n, prNumber: openedPr.prNumber, attempts: history }),
              ),
            );
          }
          if (action.type === "WaitForHuman") {
            console.log(`${prefix} → PR open, waiting for human review`);
          }
        }
      }
    }).pipe(
      // A defect (bug) in one issue's handling must never take down the loop.
      Effect.catchCause((cause) =>
        Effect.sync(() => console.error(`[${mode}] #${n} handler crashed:`, cause)),
      ),
    );

  for (;;) {
    // Wrap all top-of-loop gh calls so a transient API blip causes a retry
    // rather than an unhandled failure that exits the process. If all retries
    // fail we log the error and sleep before the next tick.
    const poll = yield* Effect.gen(function* () {
      const mergedPrs = yield* gh("listMergedPrs", issues.listMergedPrs());
      const openPrs = yield* gh("listOpenPrs", issues.listOpenPrs());
      const allPrs = [...mergedPrs, ...openPrs];

      // Reconciliation backstop: process any merges the smee listener may have missed.
      for (const pr of mergedPrs) {
        yield* handlePrMerged(pr, "reconcile");
      }

      const ready = yield* gh("listReady", issues.listReady());
      return { ok: true, allPrs, ready } as const;
    }).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          console.error(`[${mode}] poll tick failed after retries — sleeping before next tick:`, causeOf(err));
          return { ok: false } as const;
        }),
      ),
    );
    if (!poll.ok) {
      yield* Effect.sleep(RECONCILE_INTERVAL);
      continue;
    }
    const { allPrs, ready } = poll;

    const state: State = {
      issues: ready,
      prs: allPrs,
      inFlight,
      policy,
    };

    const actions = reduce(state, { type: "Tick" });

    if (actions.some((a) => a.type === "Stop")) {
      console.log(`[${mode}] nothing ready, nothing in flight — done.`);
      // Let any background work (e.g. boot-time re-reviews) finish first.
      yield* Fiber.awaitAll([...background]);
      // Shutdown sweep: confirm no containers linger after a clean exit.
      yield* sweepOrphanedSandboxesEffect(sh as ShellExec, project);
      return;
    }

    const starts = actions.filter(
      (a): a is { type: "StartSandbox"; issueId: number } => a.type === "StartSandbox",
    );

    // Apply label transitions emitted by Tick (agent:in-progress for each claimed issue).
    // Executed before the sandboxes are forked so the label is durable immediately.
    for (const action of actions) {
      if (action.type === "Relabel") {
        yield* addLabel(action.issueId, action.label).pipe(
          orLog(`[${mode}] could not add label ${action.label} to #${action.issueId}:`),
        );
      }
    }

    if (starts.length === 0) {
      // No sandbox to start this tick — either waiting for CI on open PRs or
      // all slots are occupied. Sleep and poll again.
      console.log(`[${mode}] waiting for pending PRs or in-flight sandboxes...`);
      yield* Effect.sleep(RECONCILE_INTERVAL);
      continue;
    }

    // Launch every StartSandbox the reducer emitted this tick in parallel.
    // Each runs as its own fiber; inFlight is updated synchronously so the next
    // tick's reducer counts these as occupied slots and won't over-subscribe.
    for (const start of starts) {
      const n = start.issueId;
      inFlight.push(n);
      console.log(`[${mode}] #${n} starting (${inFlight.length}/${policy.concurrency} slots in use)`);
      track(yield* Effect.forkChild(handleIssue(n, { ready, allPrs })));
    }

    // Sleep before the next reconciliation poll.
    yield* Effect.sleep(RECONCILE_INTERVAL);
  }
});

const processIssue = (
  n: number,
  issues: IssueSource,
  runner: SandboxRunner,
  base: string,
  repoRoot: string,
  mode: Mode,
): Effect.Effect<(Pr & { prNumber?: number }) | null, GhError | ShellError | SandboxError> =>
  Effect.gen(function* () {
    const issue = yield* issues.get(n);

    // Claim: drop the ready label so the next tick won't re-pick this issue.
    yield* issues.removeLabel(n, READY_LABEL);
    console.log(`[${mode}] #${n} "${issue.title}" claimed → sandbox`);

    // Refresh the base branch from origin so the sandbox branch is cut from the
    // current origin/<base>, not a stale local HEAD that would conflict at merge
    // time (#28). Runs before resetAgentBranch so the recreated branch is based
    // on fresh origin.
    yield* refreshBaseEffect(base, (args) => sh("git", args, { cwd: repoRoot }));

    // Delete any stale agent/issue-N branch (local + remote) left by a prior
    // failed/partial run, so sandcastle branches from the current base instead
    // of reusing a stale ref that would conflict at merge time (#23).
    yield* resetAgentBranchEffect(n, (args) => sh("git", args, { cwd: repoRoot }));

    // Retrieve cross-run memory (ADR-0022) — repo conventions and gotchas
    // surfaced by previous runs against this repo. Fails open to "no memory"
    // internally; never blocks the sandbox from starting.
    const memoryContext = yield* readMemoryContextEffect(issues);

    const outcome = yield* runner.runIssue(issue, memoryContext);
    console.log(
      `[${mode}] #${n} sandbox done: branch=${outcome.branch} ` +
        `commits=${outcome.commits.length} completed=${outcome.completed}` +
        (outcome.logFilePath ? ` log=${outcome.logFilePath}` : ""),
    );

    // Optional agent-emitted enrichment (ADR-0022) — piggybacks on the same
    // stdout already scanned for the completion signal, no extra agent turn.
    for (const entry of parseMemoryTags(outcome.stdout)) {
      yield* writeMemoryEntryEffect(issues, entry);
    }

    if (outcome.commits.length === 0) {
      return null;
    }

    // Orchestrator-side push (over the devcontainer's mounted SSH key) + PR.
    yield* Effect.tryPromise({
      try: () => sh("git", ["push", "-u", "origin", outcome.branch], { cwd: repoRoot }),
      catch: (cause) => new ShellError({ command: `git push -u origin ${outcome.branch}`, cause }),
    });
    const shas = outcome.commits.map((c) => c.sha.slice(0, 7)).join(", ");
    const prUrl = yield* issues
      .openPr({
        head: outcome.branch,
        base,
        title: `#${n}: ${issue.title}`,
        body:
          `Closes #${n}\n\n` +
          `Implemented autonomously by the AFK orchestrator in an isolated, ` +
          `git-isolated sandbox.\n\nCommits: ${shas}`,
      })
      .pipe(
        // Branch is pushed but PR creation failed. Log the branch name so it can
        // be recovered manually with: gh pr create --head <branch>
        Effect.tapError((err) =>
          Effect.sync(() =>
            console.error(
              `[${mode}] #${n} gh pr create failed — branch ${outcome.branch} is pushed but has no PR:`,
              causeOf(err),
            ),
          ),
        ),
      );
    yield* issues.comment(n, `Implemented in an isolated sandbox; opened ${prUrl}.`);
    console.log(`[${mode}] #${n} → ${prUrl}`);
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    return {
      issue: n,
      ciStatus: "pending" as const,
      merged: false,
      prNumber: prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined,
    };
  });

// Run only when executed directly; not when imported (e.g., in tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Run as a root fiber so SIGINT/SIGTERM interrupt it: acquire/release
  // finalizers (sandbox close, worktree cleanup) then run instead of being
  // skipped by an abrupt process exit.
  const fiber = Effect.runFork(main);
  let signal: NodeJS.Signals | undefined;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      signal = sig;
      void Effect.runPromise(Fiber.interrupt(fiber));
    });
  }
  try {
    await Effect.runPromise(Fiber.join(fiber));
  } catch (err) {
    if (!signal) throw err;
    console.log(`[afk] ${signal} received — interrupted, resources released.`);
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}
