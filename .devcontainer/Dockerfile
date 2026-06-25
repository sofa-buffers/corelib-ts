FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=24
ENV NODE_VERSION=${NODE_VERSION}

# Make npm behave well in a container
ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=true

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    build-essential \
    gnupg \
    pkg-config \
    valgrind \
    && rm -rf /var/lib/apt/lists/*

# Node.js (LTS) — the TypeScript/JavaScript runtime
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Enable Corepack for yarn/pnpm and install common global TypeScript tooling
RUN corepack enable \
    && npm install -g \
       typescript \
       ts-node \
       tsx \
       npm@latest

# Claude Code
RUN npm install -g @anthropic-ai/claude-code

# GitHub CLI (gh) — installed from GitHub's official apt repository
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["/bin/bash"]
