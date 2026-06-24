#!/usr/bin/env bash
# Spin up a self-contained devcontainer for a project, binding it as the workspace.
#
#   ./up.sh .                  bring up THIS repo (the dogfood project)
#   ./up.sh <folder>           bring up <folder> — must hold its own .devcontainer
#   ./up.sh <folder> --code    also open VS Code attached to the sandbox (-c works too)
#   ./up.sh <folder> --dry-run print the resolved container/workspace, do nothing
#
# Thin wrapper over `devcontainer up` (#42). Self-contained (#41): the workspace
# folder IS the project root that holds its own .devcontainer, so `devcontainer up`
# and VS Code "Reopen in Container" discover the config natively — no --config split,
# no AGENTIC_DC_INIT hook. The container is named per project (init.sh →
# DEVCONTAINER_NAME) so projects don't collide. The devcontainer CLI records the
# workspace folder in the container's own metadata, so GUI "Attach to Running
# Container" lands in the workspace natively — no imageConfigs hand-patching.
#
# Build layers are cached by BuildKit; --remove-existing-container drops only the
# container, not the image, so re-runs are fast. If this project's sandbox is
# already running for the same folder, up.sh reuses it instead of rebuilding.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WS="${1:?usage: up.sh <workspace-folder> [--code|-c] [--dry-run]}"
WS_ABS="$(cd "$WS" && pwd)"
shift

OPEN_CODE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    code|--code|-c) OPEN_CODE=1 ;;
    --dry-run)      DRY_RUN=1 ;;
    *) echo "usage: up.sh <workspace-folder> [--code|-c] [--dry-run]" >&2; exit 2 ;;
  esac
done

# Projects are self-contained: the target folder must hold its own .devcontainer.
if [ ! -f "${WS_ABS}/.devcontainer/devcontainer.json" ]; then
  echo "error: ${WS_ABS} has no .devcontainer/devcontainer.json — projects are self-contained (#41)." >&2
  exit 2
fi

# Per-project container name — derived by init.sh so we agree with what Compose
# uses (DEVCONTAINER_NAME).
CONTAINER="$(bash "${WS_ABS}/.devcontainer/init.sh" --dry-run "$WS_ABS" | sed -n 's/^DEVCONTAINER_NAME=//p')"

if [ "$DRY_RUN" = 1 ]; then
  printf 'WS_ABS=%s\n' "$WS_ABS"
  printf 'CONTAINER=%s\n' "$CONTAINER"
  printf 'OPEN_CODE=%s\n' "$OPEN_CODE"
  exit 0
fi

# Reuse this project's sandbox if it's already running for THIS exact folder;
# otherwise (stopped, absent, or bound to a different folder) rebuild. Empty
# result on a missing container falls through to the rebuild path.
running_folder="$(docker inspect "$CONTAINER" \
  --format '{{if .State.Running}}{{index .Config.Labels "devcontainer.local_folder"}}{{end}}' 2>/dev/null || true)"

if [ "$running_folder" = "$WS_ABS" ]; then
  echo "▸ sandbox already running for ${WS_ABS} — reusing (skip rebuild)"
else
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  devcontainer up \
    --workspace-folder "$WS_ABS" \
    --remove-existing-container
fi

# With --code, open VS Code attached to the sandbox. Best-effort and headless-safe:
# code.sh no-ops with a message if the `code` CLI isn't on PATH.
if [ "$OPEN_CODE" = 1 ]; then
  "${SCRIPT_DIR}/code.sh" "$WS_ABS" || true
fi
