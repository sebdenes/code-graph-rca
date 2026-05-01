#!/usr/bin/env node
/**
 * cgrca PR-review in GitHub Actions mode.
 *
 * Same handler as the webhook flow, but invoked from inside a workflow run
 * instead of a Fastify server. Uses the workflow's GITHUB_TOKEN for auth
 * (no app private key needed) and treats the runner's working directory as
 * the already-checked-out PR head — `actions/checkout@v4` does the clone
 * for us.
 *
 * Exit codes:
 *   0 — comment posted (or skip-comment posted) successfully
 *   1 — fatal error (invalid event, missing token, handler crashed)
 *   2 — event was not a pull_request event we can handle (no-op, not failure)
 */
import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { handlePullRequest, type PrPayload } from "./handler.js";

interface GhActionsEnv {
  GITHUB_TOKEN: string;
  GITHUB_EVENT_PATH: string;
  GITHUB_EVENT_NAME: string;
  GITHUB_WORKSPACE: string;
}

function readEnv(): GhActionsEnv {
  const need = (k: keyof GhActionsEnv): string => {
    const v = process.env[k];
    if (!v) {
      process.stderr.write(
        `[cgrca-pr-review] missing required env var: ${k}\n` +
          `(this command is meant to run inside a GitHub Actions workflow)\n`,
      );
      process.exit(1);
    }
    return v;
  };
  return {
    GITHUB_TOKEN: need("GITHUB_TOKEN"),
    GITHUB_EVENT_PATH: need("GITHUB_EVENT_PATH"),
    GITHUB_EVENT_NAME: need("GITHUB_EVENT_NAME"),
    GITHUB_WORKSPACE: need("GITHUB_WORKSPACE"),
  };
}

interface RawEvent {
  action?: string;
  number?: number;
  pull_request?: {
    number: number;
    head: {
      sha: string;
      ref: string;
      repo?: { clone_url: string; full_name: string } | null;
    };
    base: {
      repo: { full_name: string; owner: { login: string }; name: string };
    };
  };
  repository?: {
    full_name: string;
    name: string;
    owner: { login: string };
  };
}

async function main(): Promise<number> {
  const env = readEnv();
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    process.stderr.write(
      `[cgrca-pr-review] event is "${env.GITHUB_EVENT_NAME}", not "pull_request" — skipping\n`,
    );
    return 2;
  }
  let event: RawEvent;
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as RawEvent;
  } catch (err) {
    process.stderr.write(
      `[cgrca-pr-review] failed to read event payload at ${env.GITHUB_EVENT_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }
  if (!event.pull_request || !event.repository) {
    process.stderr.write(`[cgrca-pr-review] event has no pull_request — skipping\n`);
    return 2;
  }
  // We only react to opened / synchronize / reopened. The action filter in
  // the workflow YAML normally enforces this, but we double-check here so
  // a misconfigured workflow doesn't post duplicates.
  const action = event.action ?? "opened";
  if (!["opened", "synchronize", "reopened"].includes(action)) {
    process.stderr.write(
      `[cgrca-pr-review] pull_request action "${action}" — not opened/synchronize/reopened, skipping\n`,
    );
    return 2;
  }

  const payload: PrPayload = {
    action,
    number: event.number ?? event.pull_request.number,
    pull_request: {
      number: event.pull_request.number,
      head: {
        sha: event.pull_request.head.sha,
        ref: event.pull_request.head.ref,
        repo: event.pull_request.head.repo ?? null,
      },
      base: {
        repo: event.pull_request.base.repo,
      },
    },
    repository: event.repository,
  };

  // Octokit from @octokit/app already bundles the REST plugin we need.
  const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

  try {
    const result = await handlePullRequest({
      octokit: octokit as unknown as Parameters<typeof handlePullRequest>[0]["octokit"],
      payload,
      // Workflow's checkout step has the PR head ready in GITHUB_WORKSPACE.
      // Skip the clone path entirely.
      worktreeOverride: env.GITHUB_WORKSPACE,
    });
    process.stdout.write(
      `[cgrca-pr-review] status=${result.status} commentAction=${result.commentAction} ` +
        `commentId=${result.commentId ?? "-"} changedSymbols=${result.changedSymbolCount}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `[cgrca-pr-review] handler failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(
      `[cgrca-pr-review] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
