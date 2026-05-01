import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { LiveEvent } from "../../../shared/api.js";
import type { SessionRecord } from "../sessions.js";

export type LiveBroadcaster = (id: string, event: LiveEvent) => void;

export function registerLiveRoute(
  fastify: FastifyInstance,
  sessions: Map<string, SessionRecord>,
): LiveBroadcaster {
  const subscribers = new Map<string, Set<WebSocket>>();

  fastify.get<{ Params: { id: string } }>(
    "/api/session/:id/live",
    { websocket: true },
    (socket, req) => {
      const id = req.params.id;
      if (!sessions.has(id)) {
        try {
          socket.send(JSON.stringify({ error: "session not found" }));
        } catch {
          // ignore
        }
        socket.close();
        return;
      }
      let set = subscribers.get(id);
      if (!set) {
        set = new Set();
        subscribers.set(id, set);
      }
      set.add(socket);
      // No-op handshake — the client just listens.
      socket.on("close", () => {
        set?.delete(socket);
      });
      socket.on("error", () => {
        set?.delete(socket);
      });
    },
  );

  const broadcast: LiveBroadcaster = (id, event) => {
    const set = subscribers.get(id);
    if (!set) return;
    const payload = JSON.stringify(event);
    for (const ws of set) {
      try {
        ws.send(payload);
      } catch {
        // ignore individual send failures
      }
    }
  };
  return broadcast;
}
