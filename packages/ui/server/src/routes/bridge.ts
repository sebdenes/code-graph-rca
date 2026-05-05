/**
 * Bridge mode — a small live-state channel that lets a `cgrca` MCP server
 * (running inside an agent like Claude Code or Cursor) and a `cgrca-view`
 * web UI on the same machine share selection state.
 *
 * Endpoints (all mounted under /api/bridge):
 *   POST /select   body: { name, file, line, subsystem? } | null
 *                  Updates the in-memory selection. Body of `null` clears it.
 *                  Broadcasts a `{ kind: "select", payload }` LiveEvent to
 *                  all WS subscribers.
 *   GET  /select   Returns the current selection or `{ none: true }`.
 *   WS   /live     Subscribers receive every selection update as a
 *                  serialized LiveEvent.
 *
 * State is process-local — there is exactly one selection per cgrca-view
 * process. Discovery is by-convention: see `cli.ts`, which writes
 * `~/.cgrca/bridge.json` on listen and removes it on shutdown.
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { LiveEvent } from "../../../shared/api.js";

export interface BridgeSelection {
  name: string;
  file: string;
  line: number;
  subsystem?: string;
}

export interface BridgeState {
  current: BridgeSelection | null;
}

function isSelection(v: unknown): v is BridgeSelection {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string") return false;
  if (typeof o.file !== "string") return false;
  if (typeof o.line !== "number") return false;
  if (o.subsystem !== undefined && typeof o.subsystem !== "string") return false;
  return true;
}

export function registerBridgeRoute(
  fastify: FastifyInstance,
  sessionBroadcast?: (id: string, event: LiveEvent) => void,
): BridgeState {
  const state: BridgeState = { current: null };
  const subscribers = new Set<WebSocket>();

  const broadcast = (event: LiveEvent): void => {
    const payload = JSON.stringify(event);
    for (const ws of subscribers) {
      try {
        ws.send(payload);
      } catch {
        // ignore individual send failures
      }
    }
  };

  fastify.post("/api/bridge/select", async (req, reply) => {
    const body = req.body as unknown;
    if (body === null) {
      state.current = null;
      broadcast({ kind: "select", payload: null });
      return reply.send({ ok: true, current: null });
    }
    if (!isSelection(body)) {
      return reply.code(400).send({ error: "invalid selection payload" });
    }
    const sel: BridgeSelection = {
      name: body.name,
      file: body.file,
      line: body.line,
    };
    if (body.subsystem !== undefined) sel.subsystem = body.subsystem;
    state.current = sel;
    broadcast({
      kind: "select",
      payload: { name: sel.name, file: sel.file, line: sel.line },
    });
    return reply.send({ ok: true, current: sel });
  });

  fastify.get("/api/bridge/select", async (_req, reply) => {
    if (state.current === null) return reply.send({ none: true });
    return reply.send(state.current);
  });

  fastify.get(
    "/api/bridge/live",
    { websocket: true },
    (socket) => {
      subscribers.add(socket);
      socket.on("close", () => {
        subscribers.delete(socket);
      });
      socket.on("error", () => {
        subscribers.delete(socket);
      });
    },
  );

  // CLI calls this after writing a sidecar so the UI reloads without a refresh.
  fastify.post("/api/bridge/rca-notify", async (req, reply) => {
    const body = req.body as { sessionId?: string } | null;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
    if (sessionId && sessionBroadcast) {
      sessionBroadcast(sessionId, { kind: "rca-updated" });
    }
    // Also ping bridge WebSocket subscribers (e.g. MCP peers).
    broadcast({ kind: "rca-updated" });
    return reply.send({ ok: true });
  });

  return state;
}
