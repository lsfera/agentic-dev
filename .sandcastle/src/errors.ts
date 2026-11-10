/**
 * Typed errors for the orchestrator's Effect pipeline. Each one wraps the
 * underlying failure in `cause` (a defect-safe schema) so nothing is lost when
 * an error crosses a Promise boundary and is re-thrown.
 */
import { Schema } from "effect";

/** A `gh` CLI invocation failed (non-zero exit, spawn error, bad JSON). */
export class GhError extends Schema.TaggedError<GhError>()("GhError", {
  op: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A git/docker/shell command run via the orchestrator's shell seam failed. */
export class ShellError extends Schema.TaggedError<ShellError>()("ShellError", {
  command: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A sandbox lifecycle step or agent turn failed. */
export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  op: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Catch-all for an unexpected failure inside a retried or adapted operation. */
export class UnknownError extends Schema.TaggedError<UnknownError>()("UnknownError", {
  label: Schema.String,
  cause: Schema.Defect(),
}) {}
