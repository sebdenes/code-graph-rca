import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import {
  discoverSessions,
  indexById,
  loadSession,
  type SessionRecord,
} from "./sessions.js";
import { registerSessionsRoute } from "./routes/sessions.js";
import { registerRcaRoute } from "./routes/rca.js";
import { registerQueryRoute } from "./routes/query.js";
import { registerSourceRoute } from "./routes/source.js";
import { registerBlameRoute } from "./routes/blame.js";
import { registerDiffRoute } from "./routes/diff.js";
import { registerImpactRoute } from "./routes/impact.js";
import { registerGraphRoute } from "./routes/graph.js";
import { registerLiveRoute, type LiveBroadcaster } from "./routes/live.js";
import { registerBridgeRoute } from "./routes/bridge.js";
import { registerStatic } from "./static.js";

export interface CreateServerOptions {
  /** sqlite path, directory, or omit for default search */
  path?: string;
  /** dev mode: skip serving the SPA */
  dev?: boolean;
  /** max sessions discovered */
  maxSessions?: number;
  /** fastify logger */
  logger?: boolean;
}

export interface ServerHandle {
  fastify: FastifyInstance;
  sessions: Map<string, SessionRecord>;
  /** Broadcast a LiveEvent to all connected clients of a given session. */
  broadcast: LiveBroadcaster;
  /** Reload (or add) a single session by sqlite path. Returns the new record. */
  reloadSession: (sqlitePath: string) => SessionRecord | null;
  /** Close DB handles + fastify. */
  close: () => Promise<void>;
}

export async function createServer(
  opts: CreateServerOptions = {},
): Promise<ServerHandle> {
  const fastify = Fastify({ logger: opts.logger ?? false });

  // Reject path-traversal attempts at the request level: any `..` segment in
  // the raw URL targeting our source/blame/diff routes is a 400. (Fastify's
  // router normalizes `..` away by default, so without this hook the request
  // would 404 and the operator would never see the attack.)
  fastify.addHook("onRequest", async (req, reply) => {
    const u = req.raw.url ?? "";
    // Strip query/fragment for the check.
    const pathOnly = u.split("?", 1)[0] ?? "";
    if (!pathOnly.startsWith("/api/session/")) return;
    // Decode percent-encoded sequences ONCE so `%2E%2E` is caught.
    let decoded = pathOnly;
    try {
      decoded = decodeURIComponent(pathOnly);
    } catch {
      // bad encoding — also reject.
      return reply.code(400).send({ error: "invalid path" });
    }
    if (decoded.split("/").some((seg) => seg === "..")) {
      return reply.code(400).send({ error: "invalid path" });
    }
    return;
  });

  await fastify.register(websocket);

  const records = discoverSessions({
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.maxSessions !== undefined ? { max: opts.maxSessions } : {}),
  });
  const sessions = indexById(records);

  const broadcaster = registerLiveRoute(fastify, sessions);

  registerSessionsRoute(fastify, sessions);
  registerRcaRoute(fastify, sessions);
  registerQueryRoute(fastify, sessions);
  registerSourceRoute(fastify, sessions);
  registerBlameRoute(fastify, sessions);
  registerDiffRoute(fastify, sessions);
  registerImpactRoute(fastify, sessions);
  registerGraphRoute(fastify, sessions);
  registerBridgeRoute(fastify, broadcaster);

  if (!opts.dev) {
    await registerStatic(fastify);
  }

  const reloadSession = (sqlitePath: string): SessionRecord | null => {
    // Close existing handle for this id if any.
    for (const [id, rec] of sessions) {
      if (rec.summary.path === sqlitePath) {
        try {
          rec.db.close();
        } catch {
          // ignore
        }
        sessions.delete(id);
        break;
      }
    }
    const rec = loadSession(sqlitePath);
    if (rec) sessions.set(rec.summary.id, rec);
    return rec;
  };

  const close = async (): Promise<void> => {
    for (const rec of sessions.values()) {
      try {
        rec.db.close();
      } catch {
        // ignore
      }
    }
    sessions.clear();
    await fastify.close();
  };

  return { fastify, sessions, broadcast: broadcaster, reloadSession, close };
}
