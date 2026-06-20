FROM node:22-bookworm

# System dependencies for the agent's checkout + commit work.
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: sandcastle's image build defaults these to
# the host user's UID/GID so image-built files and bind-mounted worktree files
# share an owner without a runtime chown. The inner image must be UID 1000.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Claude Code CLI — the agent the orchestrator drives via claudeCode().
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In branch/worktree mode sandcastle bind-mounts the git worktree at
# /home/agent/workspace and sets it as the working directory at container start.
ENTRYPOINT ["sleep", "infinity"]
