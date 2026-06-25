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
 *   AGENTIC_CONCURRENCY   max parallel sandboxes (default: 1, serial)
 *   SMEE_URL              smee.io channel URL (enables event-driven mode)
 *   WEBHOOK_SECRET        shared HMAC secret for X-Hub-Signature-256 validation
 *
 * Concurrency note: raising AGENTIC_CONCURRENCY multiplies live resources —
 * N inner Docker sandboxes, N read-only SSH-key copies (ADR-0004), and
 * N concurrent Claude subscription seats. The safe default stays serial (1).
 */
import { createHmac } from "node:crypto";
import * as https from "node:https";
import * as http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { reduce, READY_LABEL, type State, type Pr, type Policy, type Mode } from "./reduce.ts";
import { IssueSource } from "./issue-source.ts";
import { SandboxRunner, SANDBOX_LABEL, PROJECT_LABEL_KEY, deriveProject } from "./sandbox-runner.ts";

export { SANDBOX_LABEL };

const sh = promisify(execFile);

/** Read the concurrency cap from AGENTIC_CONCURRENCY (default 1, serial). */
export function parseConcurrency(): number {
  return Math.max(1, Number(process.env.AGENTIC_CONCURRENCY ?? "1") || 1);
}

/**
 * Retry `fn` up to `maxAttempts` times with exponential backoff.
 * Throws the last error when all attempts are exhausted.
 * `sleep` is injectable for unit tests (no real network or timers needed).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    label?: string;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const {
    maxAttempts = 4,
    baseDelayMs = 2_000,
    label = "operation",
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
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

type ShellExec = (file: string, args: string[]) => Promise<{ stdout: string | Buffer }>;

type GitRun = (args: string[]) => Promise<unknown>;

/**
 * Delete the stale local and remote `agent/issue-N` branch before starting a
 * new sandbox. Best-effort — both deletions silently succeed if the branch is
 * absent. Accepts an injectable gitRun for unit testing (#23).
 */
export async function resetAgentBranch(issueId: number, gitRun: GitRun): Promise<void> {
  const branch = `agent/issue-${issueId}`;
  try { await gitRun(["branch", "-D", branch]); } catch {}
  try { await gitRun(["push", "origin", "--delete", branch]); } catch {}
}

/**
 * Refresh the local base branch to match the remote before a sandbox branch is
 * cut from it. The orchestrator branches each `agent/issue-N` off the host's
 * *local* base; if local base is stale (not pulled after an earlier PR merged),
 * the new branch is based on an old commit and its PR conflicts at merge time
 * (#28 — bit the #15 and #23 runs). Fetch + hard-reset the local base to
 * `origin/<base>` so every sandbox branches from current origin.
 *
 * Best-effort and non-fatal: the fetch is retried (withRetry) and any failure
 * is logged but swallowed — a refresh failure must not crash the run; the
 * sandbox proceeds from whatever base exists. Complements resetAgentBranch
 * (#23): that deletes the stale *branch*, this refreshes the *base*. Injectable
 * gitRun + sleep for unit testing.
 */
export async function refreshBase(
  base: string,
  gitRun: GitRun,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  try {
    await withRetry(() => gitRun(["fetch", "origin", base]), {
      label: `fetch origin ${base}`,
      sleep: opts.sleep,
    });
    await gitRun(["checkout", base]);
    await gitRun(["reset", "--hard", `origin/${base}`]);
  } catch (err) {
    console.warn(
      `[base-refresh] could not refresh '${base}' from origin ` +
        `(continuing on existing base):`,
      err,
    );
  }
}

/**
 * Remove orphaned containers that carry the agentic sandbox label.
 *
 * Called on startup (sweeps orphans from a previous crashed run) and at the
 * end of main() (confirms no containers linger after a clean exit). Each
 * individual run() call already closes its sandbox in a finally block via
 * sandcastle's internal lifecycle management; this sweep is a belt-and-
 * suspenders backstop for the SIGKILL / OOM case where those hooks never fire.
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
export async function sweepOrphanedSandboxes(
  exec: ShellExec = sh as ShellExec,
  project?: string,
): Promise<number> {
  try {
    const { stdout } = await exec("docker", [
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
    await exec("docker", ["rm", "-f", ...ids]);
    console.log(
      `[afk] swept ${ids.length} orphaned sandbox container(s)` +
        (project ? ` for project '${project}'` : ""),
    );
    return ids.length;
  } catch {
    return 0;
  }
}

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
export async function ensureSandboxNetwork(
  name: string = SANDBOX_NETWORK,
  mtu: string = SANDBOX_MTU,
  exec: ShellExec = sh as ShellExec,
): Promise<boolean> {
  try {
    await exec("docker", ["network", "inspect", name]);
    return true; // already exists
  } catch {
    // not present — create it
  }
  try {
    await exec("docker", [
      "network", "create",
      "--opt", `com.docker.network.driver.mtu=${mtu}`,
      name,
    ]);
    console.log(`[afk] created sandbox network '${name}' (mtu ${mtu})`);
    return true;
  } catch (err) {
    console.warn(
      `[afk] could not create sandbox network '${name}' (continuing on default network):`,
      err,
    );
    return false;
  }
}

/**
 * Constant-time HMAC-SHA256 validation for GitHub webhook signatures.
 * `signature` is the raw X-Hub-Signature-256 header value (`sha256=<hex>`).
 */
export function validateSignature(
  secret: string,
  rawBody: string,
  signature: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

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
export function classifyDelivery(
  secret: string | undefined,
  reserializedBody: string,
  signature: string | undefined,
): SignatureVerdict {
  if (!secret) return "no-secret";
  if (!signature) return "missing-signature";
  return validateSignature(secret, reserializedBody, signature) ? "verified" : "mismatch";
}

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
                  const verdict = classifyDelivery(
                    secret,
                    JSON.stringify(body),
                    headers["x-hub-signature-256"],
                  );
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

async function main(): Promise<void> {
  const repo = process.env.AGENTIC_REPO;
  const base = process.env.AGENTIC_BASE_BRANCH ?? "main";
  const repoRoot = process.cwd();
  // Project identity scopes the orphan sweep so concurrent projects don't reap
  // each other's in-flight sandboxes (#40).
  const project = deriveProject(repo, repoRoot);

  // Startup sweep: remove this project's orphaned containers from any previous
  // crashed run.
  await sweepOrphanedSandboxes(sh as ShellExec, project);

  // Ensure the MTU-corrected sandbox network exists so the agent's streaming
  // responses don't stall on Docker Desktop's oversized default-bridge MTU (#48).
  const networkReady = await ensureSandboxNetwork();
  const network = networkReady ? SANDBOX_NETWORK : undefined;

  const issues = new IssueSource(repo);
  const tier = (process.env.AGENTIC_TIER ?? "claude") as "claude" | "local";
  const runner = new SandboxRunner({
    imageName: process.env.SANDCASTLE_IMAGE,
    model: process.env.AGENTIC_MODEL,
    tier,
    localModel: process.env.AGENTIC_LOCAL_MODEL,
    localImageName: process.env.SANDCASTLE_OPENCODE_IMAGE,
    cwd: repoRoot,
    network,
  });

  const inFlight: number[] = [];
  // Issue ids whose PrMerged event has been dispatched to the reducer.
  // Synchronous check + add before the first await ensures concurrent smee
  // and reconciliation paths never double-dispatch the same merge.
  const seenMerges = new Set<number>();
  // GitHub X-GitHub-Delivery ids seen via smee — coarse delivery-level de-dupe.
  const seenDeliveries = new Set<string>();

  const mode = (process.env.AGENTIC_MODE ?? "afk") as Mode;
  const policy: Policy = { concurrency: parseConcurrency(), mode };

  // Dispatch a PrMerged event and execute the resulting Relabel actions.
  // Shared between the smee listener and the reconciliation poll; the
  // synchronous seenMerges check prevents double-dispatch.
  async function handlePrMerged(pr: Pr, source: string): Promise<void> {
    if (seenMerges.has(pr.issue)) return;
    seenMerges.add(pr.issue); // must stay before the first await

    console.log(`[${mode}] PR for #${pr.issue} merged (${source}) — checking dependents`);
    const allIssues = await withRetry(() => issues.listAll(), { label: "listAll" });
    const mergedPrsNow = await withRetry(() => issues.listMergedPrs(), { label: "listMergedPrs" });
    const openPrsNow = await withRetry(() => issues.listOpenPrs(), { label: "listOpenPrs" });
    const allPrsNow = [...mergedPrsNow, ...openPrsNow];

    const unblockState: State = { issues: allIssues, prs: allPrsNow, inFlight, policy };
    const unblockActions = reduce(unblockState, { type: "PrMerged", pr });
    for (const action of unblockActions) {
      if (action.type === "Relabel") {
        console.log(`[${mode}] #${pr.issue} merged → relabelling #${action.issueId} as ${action.label}`);
        await withRetry(
          () => issues.addLabel(action.issueId, action.label),
          { label: `addLabel #${action.issueId}` },
        );
      }
    }
  }

  // Start the smee webhook listener if SMEE_URL is configured (ADR-0008).
  // The reconciliation poll below acts as the backstop for missed deliveries.
  const smeeUrl = process.env.SMEE_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (smeeUrl) {
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

      try {
        await handlePrMerged({ issue: issueId, ciStatus: "success", merged: true }, `smee:${deliveryId}`);
      } catch (err) {
        console.error(`[smee] handlePrMerged #${issueId} failed:`, err);
      }
    });
  }

  // With smee handling real-time merges, the poll loop is a reconciliation
  // backstop only; 5 min is sufficient. Without smee, keep the original 60s.
  const RECONCILE_INTERVAL = smeeUrl ? 5 * 60_000 : 60_000;

  for (;;) {
    // Wrap all top-of-loop gh calls so a transient API blip causes a retry
    // rather than an unhandled rejection that exits the process. If all retries
    // fail we log the error and sleep before the next tick.
    let mergedPrs: Awaited<ReturnType<typeof issues.listMergedPrs>> = [];
    let allPrs: Awaited<ReturnType<typeof issues.listMergedPrs>> = [];
    let ready: Awaited<ReturnType<typeof issues.listReady>> = [];
    try {
      mergedPrs = await withRetry(() => issues.listMergedPrs(), { label: "listMergedPrs" });
      const openPrs = await withRetry(() => issues.listOpenPrs(), { label: "listOpenPrs" });
      allPrs = [...mergedPrs, ...openPrs];

      // Reconciliation backstop: process any merges the smee listener may have missed.
      for (const pr of mergedPrs) {
        await handlePrMerged(pr, "reconcile");
      }

      ready = await withRetry(() => issues.listReady(), { label: "listReady" });
    } catch (err) {
      console.error(`[${mode}] poll tick failed after retries — sleeping before next tick:`, err);
      await new Promise<void>((r) => setTimeout(r, RECONCILE_INTERVAL));
      continue;
    }

    const state: State = {
      issues: ready,
      prs: allPrs,
      inFlight,
      policy,
    };

    const actions = reduce(state, { type: "Tick" });

    if (actions.some((a) => a.type === "Stop")) {
      console.log(`[${mode}] nothing ready, nothing in flight — done.`);
      // Shutdown sweep: confirm no containers linger after a clean exit.
      await sweepOrphanedSandboxes(sh as ShellExec, project);
      return;
    }

    const starts = actions.filter(
      (a): a is { type: "StartSandbox"; issueId: number } => a.type === "StartSandbox",
    );

    if (starts.length === 0) {
      // No sandbox to start this tick — either waiting for CI on open PRs or
      // all slots are occupied. Sleep and poll again.
      console.log(`[${mode}] waiting for pending PRs or in-flight sandboxes...`);
      await new Promise<void>((r) => setTimeout(r, RECONCILE_INTERVAL));
      continue;
    }

    // Launch every StartSandbox the reducer emitted this tick in parallel.
    // Each fires independently; inFlight is updated synchronously so the next
    // tick's reducer counts these as occupied slots and won't over-subscribe.
    for (const start of starts) {
      const n = start.issueId;
      inFlight.push(n);
      console.log(`[${mode}] #${n} starting (${inFlight.length}/${policy.concurrency} slots in use)`);

      void (async () => {
        let openedPr: Pr | null = null;
        try {
          openedPr = await processIssue(n, issues, runner, base, repoRoot, mode);
        } catch (err) {
          console.error(`[${mode}] #${n} failed:`, err);
          // Leave the issue claimed (label removed) for a human to inspect.
        } finally {
          inFlight.splice(inFlight.indexOf(n), 1);
        }

        if (openedPr) {
          const finishState: State = {
            issues: ready,
            prs: [...allPrs, openedPr],
            inFlight,
            policy,
          };
          const finishActions = reduce(finishState, { type: "SandboxFinished", issue: n, pr: openedPr });
          for (const action of finishActions) {
            if (action.type === "EnableAutoMerge") {
              console.log(`[${mode}] #${n} → enabling auto-merge`);
              try {
                await issues.enableAutoMerge(action.pr.issue);
              } catch (err) {
                // A config gap (auto-merge disabled, no required check) must not
                // crash the orchestrator — the PR stays open for a human to merge.
                console.error(`[${mode}] #${n} could not enable auto-merge:`, err);
              }
            }
            if (action.type === "WaitForHuman") {
              console.log(`[${mode}] #${n} → PR open, waiting for human review`);
            }
          }
        }
      })();
    }

    // Sleep before the next reconciliation poll.
    await new Promise<void>((r) => setTimeout(r, RECONCILE_INTERVAL));
  }
}

async function processIssue(
  n: number,
  issues: IssueSource,
  runner: SandboxRunner,
  base: string,
  repoRoot: string,
  mode: Mode,
): Promise<Pr | null> {
  const issue = await issues.get(n);

  // Claim: drop the ready label so the next tick won't re-pick this issue.
  await issues.removeLabel(n, READY_LABEL);
  console.log(`[${mode}] #${n} "${issue.title}" claimed → sandbox`);

  // Refresh the base branch from origin so the sandbox branch is cut from the
  // current origin/<base>, not a stale local HEAD that would conflict at merge
  // time (#28). Runs before resetAgentBranch so the recreated branch is based
  // on fresh origin.
  await refreshBase(base, (args) => sh("git", args, { cwd: repoRoot }));

  // Delete any stale agent/issue-N branch (local + remote) left by a prior
  // failed/partial run, so sandcastle branches from the current base instead
  // of reusing a stale ref that would conflict at merge time (#23).
  await resetAgentBranch(n, (args) => sh("git", args, { cwd: repoRoot }));

  const outcome = await runner.runIssue(issue);
  console.log(
    `[${mode}] #${n} sandbox done: branch=${outcome.branch} ` +
      `commits=${outcome.commits.length} completed=${outcome.completed}` +
      (outcome.logFilePath ? ` log=${outcome.logFilePath}` : ""),
  );

  if (outcome.commits.length === 0) {
    // Leave the issue claimed (label stays off) so the poll loop does not
    // re-pick a persistently-failing issue every tick. A human re-labels it
    // after inspecting. (Automated backoff/retry is later work, not slice 1.)
    await issues.comment(
      n,
      "AFK agent produced no commits — leaving this issue unlabelled for a " +
        "human to inspect and re-label `ready-for-agent` if appropriate.",
    );
    return null;
  }

  // Orchestrator-side push (over the devcontainer's mounted SSH key) + PR.
  await sh("git", ["push", "-u", "origin", outcome.branch], { cwd: repoRoot });
  const shas = outcome.commits.map((c) => c.sha.slice(0, 7)).join(", ");
  let prUrl: string;
  try {
    prUrl = await issues.openPr({
      head: outcome.branch,
      base,
      title: `#${n}: ${issue.title}`,
      body:
        `Closes #${n}\n\n` +
        `Implemented autonomously by the AFK orchestrator in an isolated, ` +
        `git-isolated sandbox.\n\nCommits: ${shas}`,
    });
  } catch (err) {
    // Branch is pushed but PR creation failed. Log the branch name so it can
    // be recovered manually with: gh pr create --head <branch>
    console.error(
      `[${mode}] #${n} gh pr create failed — branch ${outcome.branch} is pushed but has no PR:`,
      err,
    );
    throw err;
  }
  await issues.comment(n, `Implemented in an isolated sandbox; opened ${prUrl}.`);
  console.log(`[${mode}] #${n} → ${prUrl}`);
  return { issue: n, ciStatus: "pending", merged: false };
}

// Run only when executed directly; not when imported (e.g., in tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
