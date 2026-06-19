#!/usr/bin/env bash
# OPTIONAL: open VS Code attached to the RUNNING devcontainer for a project folder.
#
#   ./code.sh cv        attaches VS Code, opened at /workspaces/cv
#
# The agentic workflow does NOT need this — Claude drives the container headlessly
# via the docker MCP sandbox. Use this only when you want to edit or inspect inside
# the container interactively. Run ./up.sh <folder> first if it isn't already up.
set -euo pipefail

WS="${1:?usage: code.sh <workspace-folder>}"
WS_ABS="$(cd "$WS" && pwd)"
WS_FOLDER="/workspaces/$(basename "$WS_ABS")"   # matches workspaceFolder in devcontainer.json

command -v code >/dev/null 2>&1 || { echo "VS Code 'code' CLI not found on PATH." >&2; exit 1; }

# Find the running container by the host folder it was started for.
CID="$(docker ps -q --filter "label=devcontainer.local_folder=${WS_ABS}")"
[ -n "$CID" ] || { echo "No running container for ${WS_ABS}. Start it first: ./up.sh $(basename "$WS_ABS")" >&2; exit 1; }

# Build the attached-container folder URI exactly as VS Code does, so it opens
# directly at the workspace folder instead of the container's home directory.
NAME="$(docker inspect "$CID" --format '{{.Name}}')"
CTX="$(docker context show 2>/dev/null || echo default)"
JSON="$(printf '{"containerName":"%s","settings":{"context":"%s"}}' "$NAME" "$CTX")"
HEX="$(printf '%s' "$JSON" | xxd -p | tr -d '\n')"

echo "▸ opening VS Code at ${WS_FOLDER} (container ${NAME})"
code --folder-uri "vscode-remote://attached-container+${HEX}${WS_FOLDER}"
