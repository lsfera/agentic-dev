#!/usr/bin/env bash
# Tear down devcontainer(s) created from THIS repo.
#
#   ./down.sh            tear down every container started from this repo's config
#   ./down.sh cv         tear down only the container bound to ./cv
#
# Safe by construction: containers are matched by the devcontainer labels that
# point back at THIS repo's config, so it can never remove unrelated projects'
# containers (e.g. another ~/dvcs/<name> devcontainer that happens to share a name).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${SCRIPT_DIR}/.devcontainer/devcontainer.json"
COMPOSE="${SCRIPT_DIR}/.devcontainer/docker-compose.yml"

if [ "${1:-}" ]; then
  # Scope to a single folder via the host-folder label.
  WS_ABS="$(cd "$1" && pwd)"
  FILTER=(--filter "label=devcontainer.local_folder=${WS_ABS}")
  what="$WS_ABS"
else
  # Scope to everything created from this repo's devcontainer.json.
  FILTER=(--filter "label=devcontainer.config_file=${CONFIG}")
  what="all containers from this repo"
fi

# Resolve the distinct Compose projects among matching containers, then bring each
# down via Compose (which also removes its network). Project name is derived by the
# devcontainer CLI, so we read it back rather than guessing.
projects=$(docker ps -aq "${FILTER[@]}" \
  | xargs -r docker inspect --format '{{ index .Config.Labels "com.docker.compose.project"}}' \
  | sort -u)

if [ -z "$projects" ]; then
  echo "Nothing to tear down (${what})."
  exit 0
fi

for p in $projects; do
  echo "▸ tearing down compose project: ${p}"
  docker compose --project-name "$p" -f "$COMPOSE" down
done
