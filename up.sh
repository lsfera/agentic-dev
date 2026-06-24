#!/usr/bin/env bash
# Spin up a self-contained devcontainer for a project, binding it as the workspace.
#
#   ./up.sh .                  bring up THIS repo (the dogfood project)
#   ./up.sh <folder>           bring up <folder> — must hold its own .devcontainer
#   ./up.sh <folder> --code    also open VS Code attached to the sandbox (-c works too)
#
# Self-contained (#41): the workspace folder IS the project root that holds its own
# .devcontainer, so `devcontainer up` (and VS Code "Reopen in Container") discovers
# the config natively — no --config split, no AGENTIC_DC_INIT hook. The container is
# named per project (init.sh → DEVCONTAINER_NAME), so projects don't collide.
#
# Build layers are cached automatically by BuildKit; --remove-existing-container only
# drops the container, not the image, so re-runs are fast.
#
# If the sandbox is ALREADY running for <folder>, up.sh reuses it instead of tearing
# it down and rebuilding — so `./up.sh <folder> --code` is a fast "just attach VS Code".
# Switching to a different folder still rebuilds (one sandbox at a time).
#
# After the sandbox is up, up.sh points VS Code's GUI "Attach to Running Container"
# at /workspaces/<folder> (see bind_vscode_attach_folder below), so manual attaches
# land in the workspace too. With --code it also opens VS Code attached now, via code.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WS="${1:?usage: up.sh <workspace-folder> [--code|-c]}"
WS_ABS="$(cd "$WS" && pwd)"

# Per-project container name (#41), derived by init.sh so we agree with what
# Compose will use (DEVCONTAINER_NAME). The target folder must hold its own
# .devcontainer — devcontainer up discovers it natively (no --config split).
if [ ! -f "${WS_ABS}/.devcontainer/devcontainer.json" ]; then
  echo "error: ${WS_ABS} has no .devcontainer/devcontainer.json — projects are self-contained now (#41)." >&2
  exit 2
fi
CONTAINER="$(bash "${WS_ABS}/.devcontainer/init.sh" --dry-run "$WS_ABS" | sed -n 's/^DEVCONTAINER_NAME=//p')"

# Optional 2nd arg: open VS Code attached to the sandbox after it's up.
OPEN_CODE=0
case "${2:-}" in
  "")             ;;
  code|--code|-c) OPEN_CODE=1 ;;
  *) echo "usage: up.sh <workspace-folder> [--code|-c]" >&2; exit 2 ;;
esac

# VS Code's "Attach to Running Container" (the Dev Containers GUI command, not
# code.sh) ignores devcontainer.json's workspaceFolder. Instead it keys an attach
# config by IMAGE name at:
#   <globalStorage>/ms-vscode-remote.remote-containers/imageConfigs/<image>.json
# and opens the "workspaceFolder" recorded there — defaulting to the remote user's
# home dir when absent. We write that key so attach lands in /workspaces/<folder>.
#
# One sandbox runs at a time and up.sh re-applies this on every run, so the
# image-scoped value always reflects the currently-bound folder. Best-effort:
# never abort `up.sh` if VS Code/jq aren't present.
bind_vscode_attach_folder() {
  command -v jq >/dev/null 2>&1 || { echo "⚠ jq not found; skipping VS Code attach binding" >&2; return 0; }

  local container="$CONTAINER"
  local ws_folder="/workspaces/$(basename "$WS_ABS")"

  local image
  image="$(docker inspect "$container" --format '{{.Config.Image}}' 2>/dev/null)" || return 0
  [ -n "$image" ] || return 0

  # VS Code derives the file name from the image, replacing '/' and ':' with '-'.
  local key="${image//\//-}"; key="${key//:/-}"

  local default_gs
  case "$(uname -s)" in
    Darwin) default_gs="$HOME/Library/Application Support/Code/User/globalStorage" ;;
    *)      default_gs="$HOME/.config/Code/User/globalStorage" ;;
  esac
  local dir="${VSCODE_GLOBAL_STORAGE:-$default_gs}/ms-vscode-remote.remote-containers/imageConfigs"
  local file="${dir}/${key}.json"

  mkdir -p "$dir"
  [ -f "$file" ] || printf '{}\n' > "$file"

  local tmp; tmp="$(mktemp)"
  if jq --arg wf "$ws_folder" '.workspaceFolder = $wf' "$file" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$file"
    echo "▸ VS Code attach → ${ws_folder}  (imageConfigs/${key}.json)"
  else
    rm -f "$tmp"
    echo "⚠ could not update VS Code attach config (${file}); skipping" >&2
  fi
}

# Per-project container_name ⇒ this folder's sandbox is independent of others.
# If it's already running for THIS exact folder, reuse it; otherwise (stopped,
# absent, or bound to a different folder) rebuild from scratch. Empty result on a
# missing container falls through to the rebuild path.
running_folder="$(docker inspect "$CONTAINER" \
  --format '{{if .State.Running}}{{index .Config.Labels "devcontainer.local_folder"}}{{end}}' 2>/dev/null || true)"

if [ "$running_folder" = "$WS_ABS" ]; then
  echo "▸ sandbox already running for ${WS_ABS} — reusing (skip rebuild)"
else
  # Remove any prior container for this project so a rebuild never name-conflicts.
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

  # Self-contained: the workspace folder holds its own .devcontainer, discovered
  # natively — no --config split, no AGENTIC_DC_INIT hook (#41).
  devcontainer up \
    --workspace-folder "$WS_ABS" \
    --remove-existing-container
fi

# Bind the VS Code GUI attach folder now that the container exists (best-effort).
bind_vscode_attach_folder || true

# With --code, open VS Code attached to the sandbox at /workspaces/<folder>. Best-effort
# and headless-safe: code.sh no-ops with a message if the `code` CLI isn't on PATH.
if [ "$OPEN_CODE" = 1 ]; then
  "${SCRIPT_DIR}/code.sh" "$WS_ABS" || true
fi
