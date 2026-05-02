import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { App as OctokitApp } from "@octokit/app";
import { Webhooks } from "@octokit/webhooks";
import { handlePullRequest, type PrPayload } from "./handler.js";
import { handleIncident, type HandleIncidentResult } from "./incident-handler.js";
import { parseSentryPayload } from "./sentry-parser.js";
import type { IncidentIssueApi, PrCommentApi } from "./types.js";

export interface IncidentConfig {
  /** owner/repo of the long-lived clone we RCA against. Required. */
  repoSlug: string;
  /** Local on-disk path to the long-lived clone. Required. */
  repoPath: string;
  /** HMAC-sha256 secret for validating Sentry's `Sentry-Hook-Signature`. */
  sentrySecret?: string;
  /** Bearer token for `POST /incident` (generic stack traces). */
  bearerToken?: string;
  /** Optional Octokit factory for the incident repo (single install). */
  octokitFactory?: () => Promise<IncidentIssueApi>;
  /**
   * Optional override of the rca step. Tests inject canned candidates;
   * production leaves it unset and the real `runRca` runs.
   */
  runRcaOverride?: import("./incident-handler.js").HandleIncidentOptions["runRcaOverride"];
}

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
  /**
   * Optional incident-response config. When omitted, `POST /sentry` and
   * `POST /incident` reply 503 (clearly disabled) so an operator can wire
   * the routes by setting env vars without code changes.
   */
  incident?: IncidentConfig;
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

  // We need the raw request body for HMAC validation on /sentry. Fastify
  // parses JSON by default; install a content-type parser that keeps the
  // raw buffer alongside the parsed body so we can verify signatures
  // without re-stringifying (which can disagree byte-for-byte with what
  // Sentry signed).
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      try {
        const raw = body as Buffer;
        const text = raw.toString("utf8");
        const parsed = text.length > 0 ? JSON.parse(text) : {};
        // Stash raw bytes on the request so handlers that need them can read them.
        (parsed as { __rawBody?: string }).__rawBody = text;
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  fastify.post("/webhook", async (req, reply) => {
    const id = headerString(req.headers["x-github-delivery"]);
    const name = headerString(req.headers["x-github-event"]);
    const signature = headerString(req.headers["x-hub-signature-256"]);
    if (!id || !name || !signature) {
      reply.code(400).send({ error: "missing required webhook headers" });
      return;
    }
    const raw = rawBodyFrom(req);
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

  // ---- Incident-response surface ------------------------------------------
  //
  // Two routes funnel into the same `handleIncident` function:
  //   POST /sentry   — Sentry-shaped JSON, validated via HMAC sha256 on the
  //                    `Sentry-Hook-Signature` header.
  //   POST /incident — generic stack-trace JSON, validated via Bearer token
  //                    on `Authorization`.
  //
  // Both reply 503 when their respective auth secret isn't configured, which
  // is the safest default for a public hostname: no secret means no surface.

  fastify.post("/sentry", async (req, reply) => {
    if (!opts.incident?.sentrySecret) {
      reply.code(503).send({ error: "sentry incident endpoint disabled (set SENTRY_WEBHOOK_SECRET)" });
      return;
    }
    const raw = rawBodyFrom(req);
    const sig = headerString(req.headers["sentry-hook-signature"]);
    if (!sig || !verifyHmacSha256(opts.incident.sentrySecret, raw, sig)) {
      reply.code(401).send({ error: "invalid sentry signature" });
      return;
    }
    try {
      const parsed = parseSentryPayload(stripRaw(req.body));
      const result = await runIncident(opts.incident, parsed);
      reply.code(200).send({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(400).send({ error: msg });
    }
  });

  fastify.post("/incident", async (req, reply) => {
    if (!opts.incident?.bearerToken) {
      reply.code(503).send({ error: "generic incident endpoint disabled (set INCIDENT_BEARER_TOKEN)" });
      return;
    }
    const auth = headerString(req.headers.authorization);
    const expected = `Bearer ${opts.incident.bearerToken}`;
    if (!auth || !timingSafeEq(auth, expected)) {
      reply.code(401).send({ error: "invalid bearer token" });
      return;
    }
    try {
      const body = stripRaw(req.body) as {
        issueId?: string;
        title?: string;
        failureText?: string;
      };
      if (!body.issueId || !body.failureText) {
        reply.code(400).send({ error: "missing required fields: issueId, failureText" });
        return;
      }
      const result = await runIncident(opts.incident, {
        issueId: body.issueId,
        title: body.title ?? `Incident ${body.issueId}`,
        failureText: body.failureText,
      });
      reply.code(200).send({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(500).send({ error: msg });
    }
  });

  const close = async (): Promise<void> => {
    await fastify.close();
  };

  return { fastify, webhooks, close };
}

interface NormalizedIncident {
  issueId: string;
  title: string;
  failureText: string;
}

async function runIncident(
  cfg: IncidentConfig,
  parsed: NormalizedIncident,
): Promise<HandleIncidentResult> {
  const [owner, name] = cfg.repoSlug.split("/", 2);
  if (!owner || !name) {
    throw new Error(`incident repoSlug must be 'owner/repo', got '${cfg.repoSlug}'`);
  }
  if (!cfg.octokitFactory) {
    throw new Error("incident octokitFactory not configured");
  }
  const octokit = await cfg.octokitFactory();
  return handleIncident({
    octokit,
    issueId: parsed.issueId,
    title: parsed.title,
    failureText: parsed.failureText,
    repoOwner: owner,
    repoName: name,
    repoPath: cfg.repoPath,
    ...(cfg.runRcaOverride ? { runRcaOverride: cfg.runRcaOverride } : {}),
  });
}

function headerString(v: string | string[] | undefined): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0] ?? null;
  return null;
}

function rawBodyFrom(req: FastifyRequest): string {
  const body = req.body as { __rawBody?: string } | string | undefined;
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && typeof body.__rawBody === "string") {
    return body.__rawBody;
  }
  return JSON.stringify(req.body ?? {});
}

function stripRaw(body: unknown): unknown {
  if (body && typeof body === "object") {
    const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };
    delete clone.__rawBody;
    return clone;
  }
  return body;
}

/** Constant-time HMAC sha256 hex-digest verification. */
function verifyHmacSha256(secret: string, body: string, signature: string): boolean {
  const computed = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  // Sentry sends a bare hex digest; tolerate `sha256=` prefix too.
  const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  return timingSafeEq(computed, provided);
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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
