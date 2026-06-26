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

# Optionally bake the orchestrator SOURCE into the image so adopters can run
# without vendoring .sandcastle/*.ts (ADR-0016). Gated by build-arg, so the
# compose/runtime build (the dogfood) stays lean and keeps using the workspace
# copy. We clone the COMMITTED code (not COPY the build context) so gitignored
# secrets (.sandcastle/.env, orchestrator.env) can never reach this public image.
# Only source is baked — node arrives later via a devcontainer feature, so run.sh
# installs deps into /opt on first use (chowned to vscode for that). AGENTIC_REF
# may be a branch, tag, or commit sha (GitHub allows fetching a sha directly).
ARG BAKE_ORCHESTRATOR=""
ARG AGENTIC_REF="main"
ARG AGENTIC_REPO_URL="https://github.com/lsfera/agentic-dev"
RUN if [ -n "$BAKE_ORCHESTRATOR" ]; then \
      ref="${AGENTIC_REF:-main}" && \
      git init -q /tmp/agentic-src && \
      git -C /tmp/agentic-src remote add origin "$AGENTIC_REPO_URL" && \
      git -C /tmp/agentic-src fetch -q --depth 1 origin "$ref" && \
      git -C /tmp/agentic-src checkout -q FETCH_HEAD && \
      mkdir -p /opt/agentic-orchestrator && \
      cp -a /tmp/agentic-src/.sandcastle/. /opt/agentic-orchestrator/ && \
      rm -rf /opt/agentic-orchestrator/.env /opt/agentic-orchestrator/orchestrator.env \
             /opt/agentic-orchestrator/logs /opt/agentic-orchestrator/worktrees \
             /opt/agentic-orchestrator/node_modules /tmp/agentic-src && \
      chown -R vscode:vscode /opt/agentic-orchestrator ; \
    fi

USER vscode
