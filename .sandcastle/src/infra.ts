/** Shell, git, docker-network and label helpers. Extracted from main.ts; re-exported there for existing consumers. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { ShellError } from "./errors.ts";
import { retryEffect } from "./retry.ts";
import { IN_PROGRESS_LABEL, IN_REVIEW_LABEL } from "./reduce.ts";
import { SANDBOX_LABEL, PROJECT_LABEL_KEY } from "./sandbox-runner.ts";

export const sh = promisify(execFile);

export type ShellExec = (file: string, args: string[]) => Promise<{ stdout: string | Buffer }>;

export type GitRun = (args: string[]) => Promise<unknown>;

/** Lift a Promise-returning shell seam into a typed Effect. */
export const shell = (exec: ShellExec, file: string, args: string[]) =>
  Effect.tryPromise({
    try: () => exec(file, args),
    catch: (cause) => new ShellError({ command: `${file} ${args.join(" ")}`, cause }),
  });

/** The underlying error behind a typed wrapper, for log output. */
export const causeOf = (err: unknown): unknown =>
  err && typeof err === "object" && "cause" in err && (err as { cause?: unknown }).cause !== undefined
    ? (err as { cause: unknown }).cause
    : err;

/** A human-readable one-liner for a failure (stored in the memory entry). */
export const noteOf = (err: unknown): string => {
  const c = causeOf(err);
  return c instanceof Error ? c.message : String(c);
};

/** Log-and-continue: turn any failure of `eff` into a console.error. */
export const orLog =
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
export const ensureLifecycleLabels = (repo?: string): Effect.Effect<void> => {
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
