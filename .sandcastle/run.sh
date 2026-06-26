#!/usr/bin/env bash
#
# Launch the sandcastle orchestrator with the tier/model steered by arguments,
# so /afk and /hitl can pick the agent tier without hand-editing env files.
#
# Usage:
#   run.sh <afk|hitl> [tier] [model] [flags...]
#
#   tier            "claude" (default) or "local" (Ollama via opencode)
#   model           a bare model name; applies to the selected tier. For the
#                   local tier the "ollama/" prefix is added if missing.
#   --tier <t>      explicit tier (same as the positional form)
#   --model <m>     explicit model
#   --base <b>      AGENTIC_BASE_BRANCH
#   --concurrency <n>  AGENTIC_CONCURRENCY
#   --dry-run       resolve + print the AGENTIC_* env and exit (no launch,
#                   no orchestrator.env sourced) — used by the tests
#
# Examples:
#   run.sh afk
#   run.sh afk local
#   run.sh afk local qwen2.5-coder:32b
#   run.sh hitl --tier local --model qwen2.5-coder:32b
#   run.sh afk --base develop --concurrency 2
set -euo pipefail

MODE="" TIER="" MODEL="" BASE="" CONCURRENCY="" DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    afk|hitl)     MODE="$1" ;;
    claude|local) TIER="$1" ;;
    --tier)        TIER="${2:?--tier needs a value}"; shift ;;
    --model)       MODEL="${2:?--model needs a value}"; shift ;;
    --base)        BASE="${2:?--base needs a value}"; shift ;;
    --concurrency) CONCURRENCY="${2:?--concurrency needs a value}"; shift ;;
    --dry-run)     DRY_RUN=1 ;;
    --)            shift; break ;;
    -*)            echo "run.sh: unknown flag '$1'" >&2; exit 2 ;;
    *)             MODEL="$1" ;;  # a bare positional is the model name
  esac
  shift
done

if [ "$MODE" != "afk" ] && [ "$MODE" != "hitl" ]; then
  echo "run.sh: first argument must be 'afk' or 'hitl' (got '${MODE}')" >&2
  exit 2
fi

# Resolve overrides into the AGENTIC_* names the orchestrator reads. These are
# applied AFTER orchestrator.env is sourced (below) so arguments win over the
# env file.
resolve_overrides() {
  export AGENTIC_MODE="$MODE"
  [ -n "$TIER" ] && export AGENTIC_TIER="$TIER"
  [ -n "$BASE" ] && export AGENTIC_BASE_BRANCH="$BASE"
  [ -n "$CONCURRENCY" ] && export AGENTIC_CONCURRENCY="$CONCURRENCY"

  if [ -n "$MODEL" ]; then
    # The model applies to whichever tier is in effect.
    local effective_tier="${TIER:-${AGENTIC_TIER:-claude}}"
    if [ "$effective_tier" = "local" ]; then
      case "$MODEL" in
        ollama/*) export AGENTIC_LOCAL_MODEL="$MODEL" ;;
        *)        export AGENTIC_LOCAL_MODEL="ollama/$MODEL" ;;
      esac
    else
      export AGENTIC_MODEL="$MODEL"
    fi
  fi
}

if [ "$DRY_RUN" = "1" ]; then
  # Hermetic: resolve and print the AGENTIC_* env only — no secrets sourced,
  # no orchestrator launched. The tests assert on this output.
  resolve_overrides
  env | grep '^AGENTIC_' | sort
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Run from the path-matched mount so sandcastle's worktrees resolve under
# docker-outside-of-docker (ADR-0011) — not from /workspaces/<folder>. This is the
# orchestrator's cwd, so worktrees, .sandcastle/.env, and project identity all
# resolve against the TARGET project regardless of where the code itself lives.
cd "${LOCAL_WORKSPACE_FOLDER:-$REPO_ROOT}"

# Resolve the orchestrator CODE directory (ADR-0016). Prefer the workspace copy
# when it carries the source — the dogfood repo, or an adopter who vendors
# .sandcastle/ — so local edits take effect; otherwise fall back to the
# orchestrator baked into the devcontainer image, letting adopters run without
# vendoring the *.ts at all. Either way config (orchestrator.env / .env /
# opencode.json) comes from the project's .sandcastle/, never from the baked copy.
ORCH_HOME="${AGENTIC_ORCHESTRATOR_HOME:-/opt/agentic-orchestrator}"
if [ -f "$PWD/.sandcastle/main.ts" ]; then
  ORCH_DIR="$PWD/.sandcastle"
elif [ -f "$ORCH_HOME/main.ts" ]; then
  ORCH_DIR="$ORCH_HOME"
else
  echo "run.sh: no orchestrator found — expected .sandcastle/main.ts in the project or a baked $ORCH_HOME" >&2
  exit 1
fi

# Install deps only when missing or stale — not on every run. npm writes
# node_modules/.package-lock.json, so -nt against package-lock.json detects a
# changed lockfile. This covers both the workspace copy and the baked copy: the
# image ships only the orchestrator *source* (node not yet present when the
# Dockerfile runs — it arrives via a devcontainer feature), so the baked copy
# installs its deps on first use, once per container.
if [ ! -x "$ORCH_DIR/node_modules/.bin/tsx" ] ||
   [ "$ORCH_DIR/package-lock.json" -nt "$ORCH_DIR/node_modules/.package-lock.json" ]; then
  ( cd "$ORCH_DIR" && npm install )
fi

# Source GH_TOKEN for the orchestrator's own gh calls; kept out of the sandboxes.
if [ -f .sandcastle/orchestrator.env ]; then
  set -a
  # shellcheck disable=SC1091
  . .sandcastle/orchestrator.env
  set +a
else
  echo "run.sh: warning — no .sandcastle/orchestrator.env (GH_TOKEN); gh calls may fail" >&2
fi

resolve_overrides  # arguments override anything orchestrator.env set

exec "$ORCH_DIR/node_modules/.bin/tsx" "$ORCH_DIR/main.ts"
