#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { App as OctokitApp } from "@octokit/app";
import { createApp, type IncidentConfig } from "./server.js";
import type { IncidentIssueApi } from "./types.js";

function readEnv(name: string): string | null {
  const v = process.env[name];
  return v && v.length > 0 ? v : null;
}

function loadPrivateKey(): string {
  const direct = readEnv("GITHUB_APP_PRIVATE_KEY");
  if (direct) return direct.replace(/\\n/g, "\n");
  const path = readEnv("GITHUB_APP_PRIVATE_KEY_PATH");
  if (path) return readFileSync(path, "utf8");
  throw new Error(
    "Set GITHUB_APP_PRIVATE_KEY (PEM contents) or GITHUB_APP_PRIVATE_KEY_PATH (file path)",
  );
}

async function main(): Promise<void> {
  const appId = readEnv("GITHUB_APP_ID");
  const webhookSecret = readEnv("GITHUB_WEBHOOK_SECRET");
  if (!appId) throw new Error("GITHUB_APP_ID is required");
  if (!webhookSecret) throw new Error("GITHUB_WEBHOOK_SECRET is required");
  const privateKey = loadPrivateKey();
  const port = parseInt(readEnv("PORT") ?? "3000", 10);

  const incident = buildIncidentConfig({ appId, privateKey, webhookSecret });

  const { fastify } = createApp({
    appId,
    privateKey,
    webhookSecret,
    ...(incident ? { incident } : {}),
  });
  await fastify.listen({ port, host: "0.0.0.0" });
  fastify.log.info(
    { port, incident: Boolean(incident) },
    "cgrca github-app listening",
  );
}

/**
 * Pull incident-response config out of the env. Returns null when neither
 * SENTRY_WEBHOOK_SECRET nor INCIDENT_BEARER_TOKEN is set — in that case the
 * /sentry and /incident routes reply 503 (clearly disabled).
 *
 * The Octokit factory resolves the installation id for INCIDENT_REPO lazily
 * on the first incident, so a missing/uninstalled repo only fails the first
 * incident POST instead of crashing startup.
 */
function buildIncidentConfig(creds: {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}): IncidentConfig | null {
  const sentrySecret = readEnv("SENTRY_WEBHOOK_SECRET");
  const bearerToken = readEnv("INCIDENT_BEARER_TOKEN");
  if (!sentrySecret && !bearerToken) return null;

  const repoSlug = readEnv("INCIDENT_REPO");
  const repoPath = readEnv("INCIDENT_REPO_PATH");
  if (!repoSlug || !repoPath) {
    throw new Error(
      "Incident endpoints enabled (SENTRY_WEBHOOK_SECRET or INCIDENT_BEARER_TOKEN set) but INCIDENT_REPO=owner/repo and INCIDENT_REPO_PATH=/path/to/clone are required",
    );
  }
  const [owner, repo] = repoSlug.split("/", 2);
  if (!owner || !repo) {
    throw new Error(`INCIDENT_REPO must be 'owner/repo', got '${repoSlug}'`);
  }

  const app = new OctokitApp({
    appId: creds.appId,
    privateKey: creds.privateKey,
    webhooks: { secret: creds.webhookSecret },
  });

  let cached: IncidentIssueApi | null = null;
  const octokitFactory = async (): Promise<IncidentIssueApi> => {
    if (cached) return cached;
    const inst = await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo,
    });
    const installationId = (inst.data as { id?: number }).id;
    if (typeof installationId !== "number") {
      throw new Error(`could not resolve installation id for ${owner}/${repo}`);
    }
    const oct = await app.getInstallationOctokit(installationId);
    cached = oct as unknown as IncidentIssueApi;
    return cached;
  };

  return {
    repoSlug,
    repoPath,
    ...(sentrySecret ? { sentrySecret } : {}),
    ...(bearerToken ? { bearerToken } : {}),
    octokitFactory,
  };
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
