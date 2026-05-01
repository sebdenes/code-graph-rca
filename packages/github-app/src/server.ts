import Fastify, { type FastifyInstance } from "fastify";
import { App as OctokitApp } from "@octokit/app";
import { Webhooks } from "@octokit/webhooks";
import { handlePullRequest, type PrPayload } from "./handler.js";
import type { PrCommentApi } from "./types.js";

export interface CreateAppOptions {
  appId: string | number;
  privateKey: string;
  webhookSecret: string;
  /** Optional logger pass-through; defaults to fastify's default. */
  logLevel?: "info" | "warn" | "error" | "debug" | "fatal";
  /**
   * Optional override of the per-installation Octokit factory. Used by tests
   * to inject a mock without minting a real installation token.
   */
  octokitFactory?: (installationId: number) => Promise<PrCommentApi>;
}

export interface AppHandle {
  fastify: FastifyInstance;
  webhooks: Webhooks;
  close: () => Promise<void>;
}

/**
 * Build a Fastify server with `/webhook` (signature-verified) and `/healthz`.
 * Does not call `listen()`; callers (cli.ts / tests) are responsible.
 */
export function createApp(opts: CreateAppOptions): AppHandle {
  const fastify = Fastify({ logger: { level: opts.logLevel ?? "info" } });

  const webhooks = new Webhooks({ secret: opts.webhookSecret });

  const octokitFactory =
    opts.octokitFactory ?? makeRealOctokitFactory(opts);

  webhooks.on(["pull_request.opened", "pull_request.synchronize"], async (event) => {
    const payload = event.payload as unknown as PrPayload;
    const installationIdRaw = (event.payload as { installation?: { id?: number } }).installation?.id;
    const installationId = typeof installationIdRaw === "number" ? installationIdRaw : 0;
    const octokit = await octokitFactory(installationId);
    try {
      await handlePullRequest({ octokit, payload });
    } catch (err) {
      fastify.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "handlePullRequest failed",
      );
    }
  });

  fastify.get("/healthz", async () => ({ ok: true }));

  fastify.post("/webhook", async (req, reply) => {
    const id = headerString(req.headers["x-github-delivery"]);
    const name = headerString(req.headers["x-github-event"]);
    const signature = headerString(req.headers["x-hub-signature-256"]);
    if (!id || !name || !signature) {
      reply.code(400).send({ error: "missing required webhook headers" });
      return;
    }
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    try {
      await webhooks.verifyAndReceive({
        id,
        name: name as Parameters<Webhooks["verifyAndReceive"]>[0]["name"],
        signature,
        payload: raw,
      });
      reply.code(200).send({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/signature/i.test(msg)) {
        reply.code(401).send({ error: "invalid signature" });
        return;
      }
      reply.code(500).send({ error: msg });
    }
  });

  const close = async (): Promise<void> => {
    await fastify.close();
  };

  return { fastify, webhooks, close };
}

function headerString(v: string | string[] | undefined): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0] ?? null;
  return null;
}

function makeRealOctokitFactory(
  opts: CreateAppOptions,
): (installationId: number) => Promise<PrCommentApi> {
  const app = new OctokitApp({
    appId: opts.appId,
    privateKey: opts.privateKey,
    webhooks: { secret: opts.webhookSecret },
  });
  return async (installationId: number) => {
    const oct = await app.getInstallationOctokit(installationId);
    return oct as unknown as PrCommentApi;
  };
}
