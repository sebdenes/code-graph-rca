# cgrca github-app

A GitHub App that runs [code-graph-rca](https://github.com/sebdenes/code-graph-rca) on every PR and posts a single, idempotent comment with:

- the top-3 changed symbols ranked by causal score,
- a blast-radius summary (transitive callers + top untested ones),
- recent commits in the affected neighborhood, and
- a collapsible block of unresolved-call hints (grep-bait for the LLM that reviews the PR).

The same comment is updated in place on every `synchronize` event.

## Environment

| Variable | Purpose |
| --- | --- |
| `GITHUB_APP_ID` | Numeric App ID from the GitHub App settings page. |
| `GITHUB_APP_PRIVATE_KEY` _or_ `GITHUB_APP_PRIVATE_KEY_PATH` | PEM contents (with literal `\n` allowed) **or** a filesystem path to the `.pem` file. |
| `GITHUB_WEBHOOK_SECRET` | The shared secret that GitHub uses to sign delivery payloads. |
| `PORT` | Optional, default `3000`. |

## Register the GitHub App

1. https://github.com/settings/apps → **New GitHub App**.
2. Set **Webhook URL** to `https://<your-host>/webhook`.
3. Set **Webhook secret** to the same value as `GITHUB_WEBHOOK_SECRET`.
4. **Repository permissions:**
   - `pull_requests`: **Read & write**
   - `contents`: **Read**
   - `issues`: **Read & write**
5. **Subscribe to events:** `Pull request`.
6. Generate a private key (download `.pem`) and either pass its contents in `GITHUB_APP_PRIVATE_KEY` or its path in `GITHUB_APP_PRIVATE_KEY_PATH`.
7. Install the App on the org/repos you want it to review.

## Run locally

```bash
npm -w packages/github-app run build
GITHUB_APP_ID=12345 \
GITHUB_APP_PRIVATE_KEY_PATH=./cgrca.pem \
GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32) \
PORT=3000 \
node packages/github-app/dist/cli.js
```

Use [smee.io](https://smee.io/) or `cloudflared tunnel` to forward GitHub deliveries to `localhost`.

## Deploy: Fly.io

```bash
# fly.toml app = "cgrca-github-app", primary_region = "iad"
fly launch --copy-config --no-deploy
fly secrets set \
  GITHUB_APP_ID=12345 \
  GITHUB_APP_PRIVATE_KEY="$(cat cgrca.pem)" \
  GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
fly deploy
```

A minimal `Dockerfile` ships in this directory; Fly auto-detects it.

## Deploy: Vercel (Node serverless)

This app must run as a **Node** serverless function (not Edge — it shells out to `git` and uses native sqlite).

`vercel.json`:

```json
{
  "version": 2,
  "builds": [
    { "src": "packages/github-app/dist/cli.js", "use": "@vercel/node" }
  ],
  "routes": [
    { "src": "/(.*)", "dest": "/packages/github-app/dist/cli.js" }
  ],
  "functions": {
    "packages/github-app/dist/cli.js": { "memory": 1024, "maxDuration": 60 }
  }
}
```

Set the same env vars in **Project → Settings → Environment Variables**. Note that Vercel functions are short-lived, so very large monorepos may exceed the 60s budget — for those, prefer Fly.io or a long-running VM.

## Self-host with Docker

```bash
docker build -t cgrca-gha -f packages/github-app/Dockerfile .
docker run --rm -p 3000:3000 \
  -e GITHUB_APP_ID=12345 \
  -e GITHUB_APP_PRIVATE_KEY="$(cat cgrca.pem)" \
  -e GITHUB_WEBHOOK_SECRET=... \
  cgrca-gha
```

## Tests

```bash
npm -w packages/github-app test
```
