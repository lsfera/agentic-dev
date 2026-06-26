FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# The Docker CLI, Compose, and host-socket access are provided by the
# docker-outside-of-docker feature (see devcontainer.json). The feature also
# fixes the socket group for the non-root user at container startup, so no
# manual CLI install or DOCKER_GID handling is needed here.

COPY claude-persist-setup /usr/local/bin/claude-persist-setup

# Ergonomic orchestrator launchers: `afk` / `hitl` from anywhere in a project,
# instead of `.sandcastle/run.sh afk …`. The mode is dispatched from the invoked
# name, so `hitl` is a symlink to the same script (busybox-style multi-call).
COPY afk /usr/local/bin/afk
RUN chmod +x /usr/local/bin/claude-persist-setup /usr/local/bin/afk \
  && ln -sf afk /usr/local/bin/hitl

USER vscode
