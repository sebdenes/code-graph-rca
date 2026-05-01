FROM node:20-bookworm-slim

WORKDIR /app

# git is needed by the recentlyChangedNear query at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# better-sqlite3 ships prebuilt binaries for linux x64; no native build tools needed.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts && npm rebuild better-sqlite3 || npm install --omit=dev

COPY dist/ ./dist/
COPY README.md LICENSE ./

ENTRYPOINT ["node", "dist/cli.js"]
