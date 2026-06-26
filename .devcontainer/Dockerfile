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

# Optionally bake the orchestrator SOURCE (ADR-0016) + workflow slash commands +
# upstream engineering-discipline skills (ADR-0017) into the image so adopters can run
# without vendoring .sandcastle/*.ts or .claude/commands/*.md. Gated by build-arg, so the
# compose/runtime build (the dogfood) stays lean and keeps using the workspace copy.
# We clone the COMMITTED code (not COPY the build context) so gitignored secrets
# (.sandcastle/.env, orchestrator.env) can never reach this public image — and so files
# outside the .devcontainer build context (the repo-root .claude/commands) are still
# reachable. The clone path also lets us pull the upstream skills without node (npm/npx
# arrive only later, via a devcontainer feature). Only source is baked — node arrives
# later, so run.sh installs deps into /opt on first use (chowned to vscode for that).
# claude-persist-setup installs the baked commands → ~/.claude/commands and the baked
# skills → ~/.claude/skills at container creation.
# AGENTIC_REF may be a branch, tag, or commit sha (GitHub allows fetching a sha directly).
ARG BAKE_ORCHESTRATOR=""
ARG AGENTIC_REF="main"
ARG AGENTIC_REPO_URL="https://github.com/lsfera/agentic-dev"
# Upstream model-invoked engineering disciplines (ADR-0017), baked from mattpocock/skills
# (MIT, © Matt Pocock — LICENSE preserved at /opt/agentic-skills). The repo's
# *user-invoked* workflow commands (/afk, /hitl, /exec, /to-prd, /to-issues, /tdd,
# /grill-me-with-docs) are the project's own — they are coupled to the sandcastle
# flow (the `ready-for-agent` label, `/exec`→docker MCP, the docs/ handoff chain),
# so they stay vendored at /opt/agentic-commands. Only the un-forked disciplines
# the workflow leans on are pulled fresh from upstream, into /opt/agentic-skills.
ARG MATT_SKILLS_REF="main"
ARG MATT_SKILLS_REPO_URL="https://github.com/mattpocock/skills"
RUN if [ -n "$BAKE_ORCHESTRATOR" ]; then \
      ref="${AGENTIC_REF:-main}" && \
      git init -q /tmp/agentic-src && \
      git -C /tmp/agentic-src remote add origin "$AGENTIC_REPO_URL" && \
      git -C /tmp/agentic-src fetch -q --depth 1 origin "$ref" && \
      git -C /tmp/agentic-src checkout -q FETCH_HEAD && \
      mkdir -p /opt/agentic-orchestrator /opt/agentic-commands /opt/agentic-skills && \
      cp -a /tmp/agentic-src/.sandcastle/. /opt/agentic-orchestrator/ && \
      cp -a /tmp/agentic-src/.claude/commands/. /opt/agentic-commands/ && \
      sref="${MATT_SKILLS_REF:-main}" && \
      git init -q /tmp/matt-skills && \
      git -C /tmp/matt-skills remote add origin "$MATT_SKILLS_REPO_URL" && \
      git -C /tmp/matt-skills fetch -q --depth 1 origin "$sref" && \
      git -C /tmp/matt-skills checkout -q FETCH_HEAD && \
      cp -a /tmp/matt-skills/skills/engineering/tdd \
            /tmp/matt-skills/skills/engineering/diagnosing-bugs \
            /tmp/matt-skills/skills/engineering/domain-modeling \
            /tmp/matt-skills/skills/engineering/codebase-design \
            /opt/agentic-skills/ && \
      cp -a /tmp/matt-skills/LICENSE /opt/agentic-skills/LICENSE.mattpocock-skills && \
      rm -rf /opt/agentic-orchestrator/.env /opt/agentic-orchestrator/orchestrator.env \
             /opt/agentic-orchestrator/logs /opt/agentic-orchestrator/worktrees \
             /opt/agentic-orchestrator/node_modules /tmp/agentic-src /tmp/matt-skills && \
      chown -R vscode:vscode /opt/agentic-orchestrator /opt/agentic-commands /opt/agentic-skills ; \
    fi

USER vscode
