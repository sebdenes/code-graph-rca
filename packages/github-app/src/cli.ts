#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createApp } from "./server.js";

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

  const { fastify } = createApp({ appId, privateKey, webhookSecret });
  await fastify.listen({ port, host: "0.0.0.0" });
  fastify.log.info({ port }, "cgrca github-app listening");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
