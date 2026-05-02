# code-graph-rca-github-app

GitHub Action and webhook server for [code-graph-rca](https://www.npmjs.com/package/code-graph-rca) on real workflows. On every pull request, index the changed scope, rank the most likely root-cause sites, compute the blast radius, and post one idempotent comment that updates in place on every push. On every production incident (Sentry or any alertmanager), run RCA against the configured repo at HEAD and open a GitHub issue with ranked candidates — so the on-call has a head start instead of a raw stack trace.

For the high-level pitch and architecture, see the [repo README](https://github.com/sebdenes/code-graph-rca#readme).

v0.4.0. Three surfaces, one handler: **Action mode**, **App mode**, and **Incident mode** (new this release).

## 1. Action mode (no hosting)

Drop this at `.github/workflows/cgrca-pr-review.yml`:

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
      - uses: sebdenes/code-graph-rca@latest
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

That's it — no secrets to register, no service to deploy. The composite action installs `code-graph-rca-github-app` from npm and runs `cgrca-pr-review` against the PR head using the runner's `GITHUB_TOKEN`. Pin to a specific version with `pr-review-version: <semver>` if you don't want to track `latest`.

The comment is upserted by an HTML marker (`<!-- cgrca-comment -->`), so re-pushes update the same comment instead of stacking new ones. The comment template lists the top causal candidates, the changed-scope summary, and a blast-radius section for each touched symbol.

## 2. App mode (hosted webhook)

Use this when you want one bot identity reviewing PRs across many repos under a shared install, instead of dropping a workflow file into each one.

```sh
npm install -g code-graph-rca-github-app
code-graph-rca-github-app          # reads env, listens on PORT (default 3000)
```

Endpoint: `POST /webhook` (GitHub `pull_request` events).

| Variable | Purpose |
| --- | --- |
| `GITHUB_APP_ID` | Numeric App ID from the GitHub App settings page. |
| `GITHUB_APP_PRIVATE_KEY` *or* `GITHUB_APP_PRIVATE_KEY_PATH` | PEM contents (with literal `\n` allowed) **or** a filesystem path to the `.pem`. |
| `GITHUB_WEBHOOK_SECRET` | The shared secret that signs delivery payloads. |
| `PORT` | Optional, default `3000`. |

### Register the GitHub App

1. https://github.com/settings/apps → **New GitHub App**.
2. **Webhook URL**: `https://<your-host>/webhook`.
3. **Webhook secret**: same value as `GITHUB_WEBHOOK_SECRET`.
4. **Repository permissions**: `pull_requests` Read & write, `contents` Read, `issues` Read & write.
5. **Subscribe to events**: `Pull request`.
6. Generate a private key, then pass its contents in `GITHUB_APP_PRIVATE_KEY` or its path in `GITHUB_APP_PRIVATE_KEY_PATH`.
7. Install the App on the org/repos to review.

For local dev: `smee.io` or `cloudflared tunnel` to forward GitHub deliveries to `localhost:3000`. A minimal `Dockerfile` ships in this directory for Fly.io / Railway / VPS deploys.

## 3. Incident mode (new this release)

When a production error fires, point Sentry (or any alertmanager / script) at the same hosted server. cgrca runs RCA against the configured repo at HEAD and opens a GitHub issue with the ranked candidates.

Two endpoints, one handler:

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /sentry` | HMAC-SHA256 `Sentry-Hook-Signature` against `SENTRY_WEBHOOK_SECRET` | Sentry "internal integration" / issue-alert webhooks. |
| `POST /incident` | `Authorization: Bearer $INCIDENT_BEARER_TOKEN` | Generic JSON `{ issueId, title, failureText }` from any source. |

Both routes are **disabled by default** — when neither secret is set, they reply `503 { "error": "...endpoint disabled..." }`, so a public hostname doesn't accidentally accept anonymous incident POSTs.

| Variable | Purpose |
| --- | --- |
| `SENTRY_WEBHOOK_SECRET` | HMAC-SHA256 secret shared with Sentry. |
| `INCIDENT_BEARER_TOKEN` | Bearer token required on `POST /incident`. |
| `INCIDENT_REPO` | `owner/repo` of the long-lived clone to RCA against (single repo per install for now). |
| `INCIDENT_REPO_PATH` | Filesystem path to the long-lived clone. |

### Wire it up in Sentry

1. Sentry → **Settings → Developer Settings → New Internal Integration**.
2. **Webhook URL**: `https://<your-host>/sentry`.
3. **Webhook secret**: paste the same value as `SENTRY_WEBHOOK_SECRET`.
4. **Permissions**: `Issues & Events: Read`.
5. **Webhooks**: subscribe to `issue: created` (and optionally `issue: resolved`).
6. Install the integration on the project that fires for your prod service.

### Generic stack traces (no Sentry)

```sh
curl -X POST https://<your-host>/incident \
  -H "Authorization: Bearer $INCIDENT_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "issueId": "ops-2026-05-02-001",
    "title": "API 500s on /v1/login",
    "failureText": "TypeError: undefined is not a function\n  at handleLogin (src/api/login.ts:42)"
  }'
```

If `runRca` itself fails (parse error, repo mismatch, timeout) the endpoint still files a GitHub issue containing `RCA failed: <error>` plus the original failure text — the alert is never silently dropped.

## Idempotency and retries

PR comments and incident issues are both keyed by HTML markers — `<!-- cgrca-comment -->` for PR review, `<!-- cgrca-incident:<id> -->` for incidents. Re-fires of the same PR push or the same Sentry issue id update the existing comment / issue in place instead of stacking duplicates.

All GitHub API calls go through a retry wrapper (transient 5xx, `EPIPE`, `ECONNRESET`, `ECONNREFUSED`, secondary-rate-limit `retry-after`) — the v0.3.2 fix after the action ran into a flaky GitHub edge in long-running workflows.

## Run locally

```sh
GITHUB_APP_ID=12345 \
GITHUB_APP_PRIVATE_KEY_PATH=./cgrca.pem \
GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32) \
PORT=3000 \
code-graph-rca-github-app
```

## Tests

```sh
npm -w packages/github-app test
```

## Status

Production at one-org scale; multi-repo incident mode is single-repo per install for now (one `INCIDENT_REPO`).

## License

MIT.
