# Multi-stage build for the cgrca GitHub App.
# Build context must be the repo root (the workspace dependency on `code-graph-rca`
# is a sibling package).
FROM node:20-bookworm-slim AS builder
WORKDIR /repo

# Install build deps for better-sqlite3 and tree-sitter.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/github-app/package.json packages/github-app/package.json
RUN npm ci --ignore-scripts || npm install --ignore-scripts

COPY packages/core packages/core
COPY packages/github-app packages/github-app

RUN npm -w packages/core run build \
  && npm -w packages/github-app run build

# ---- runtime ----
FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /repo/node_modules /app/node_modules
COPY --from=builder /repo/packages/core/dist /app/packages/core/dist
COPY --from=builder /repo/packages/core/package.json /app/packages/core/package.json
COPY --from=builder /repo/packages/github-app/dist /app/packages/github-app/dist
COPY --from=builder /repo/packages/github-app/package.json /app/packages/github-app/package.json

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "packages/github-app/dist/cli.js"]
