# syntax=docker/dockerfile:1

# ---- 1. Build the admin dashboard (web/ needs Node >= 22.22) ----
FROM node:24-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- 2. Runtime ----
FROM node:24-bookworm-slim

# git + ssh for repo sync, tini as PID 1 (forwards SIGTERM to node and reaps orphaned claude subprocesses).
# Add here whatever toolchains the TARGET repos need for their agent jobs (e.g. Playwright browsers, python, ...).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI, installed globally (outside $HOME, which is a volume holding the login).
# Pin a version for reproducible builds: --build-arg CLAUDE_CODE_VERSION=2.1.332
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

ENV NODE_ENV=production \
    DISABLE_AUTOUPDATER=1 \
    PORT=8080

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --from=web /app/web/dist ./web/dist

RUN mkdir -p /app/workspaces /app/data && chown -R node:node /app/workspaces /app/data

# claude refuses --permission-mode bypassPermissions as root
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
