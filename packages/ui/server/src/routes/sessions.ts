import type { FastifyInstance } from "fastify";
import type { SessionsResponse } from "../../../shared/api.js";
import type { SessionRecord } from "../sessions.js";

export function registerSessionsRoute(
  fastify: FastifyInstance,
  sessions: Map<string, SessionRecord>,
): void {
  fastify.get("/api/sessions", async (): Promise<SessionsResponse> => {
    const list = Array.from(sessions.values()).map((r) => r.summary);
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { sessions: list };
  });
}
