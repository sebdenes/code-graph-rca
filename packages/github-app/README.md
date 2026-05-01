# code-graph-rca-github-app

PR-review for [code-graph-rca](https://github.com/sebdenes/code-graph-rca). On every pull request: index the changed scope, rank the most likely root-cause sites, compute the blast radius, post a single idempotent comment that updates in place on every push.

**Two ways to use it:**

| | **GitHub Action** (`cgrca-pr-review`) | **GitHub App** (`cgrca-github-app`) |
|---|---|---|
| Hosting | none — runs on the PR's GitHub Actions runner | persistent webhook server you host (Fly / Render / Railway / VPS) |
| Setup | drop one workflow file in `.github/workflows/` | register an App in github.com, deploy this server, point the webhook |
| Auth | the runner's `GITHUB_TOKEN` | a private key + installation token |
| Best for | individual repos, OSS, fast adoption | hosting cgrca-as-a-service across many repos under one bot identity |

Both modes call the same handler and produce the same comment. Pick whichever fits your distribution model.

## Path A — GitHub Action (recommended start)

Drop this at `.github/workflows/cgrca.yml`:

```yaml
name: cgrca PR review
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
  issues: write
jobs:
  cgrca:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: sebdenes/code-graph-rca@v0.3.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

That's it. No secrets to register, no service to deploy. The Action installs `code-graph-rca-github-app` from npm, runs it against the PR head, posts the comment.

The comment is upserted by an HTML marker (`<!-- cgrca-pr-bot:v1 -->`), so re-pushes update the same comment instead of stacking new ones.

## Path B — GitHub App (hosted webhook)

The original mode. Use when you want one bot identity reviewing PRs across many repos under a shared install — not per-repo workflow files.

### Environment

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
