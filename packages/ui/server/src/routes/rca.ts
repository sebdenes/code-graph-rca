import type { FastifyInstance } from "fastify";
import type { SessionRecord } from "../sessions.js";

export function registerRcaRoute(
  fastify: FastifyInstance,
  sessions: Map<string, SessionRecord>,
): void {
  fastify.get<{ Params: { id: string } }>(
    "/api/session/:id/rca",
    async (req, reply) => {
      const rec = sessions.get(req.params.id);
      if (!rec) {
        return reply.code(404).send({ error: "session not found" });
      }
      if (!rec.snapshot) {
        return reply
          .code(404)
          .send({ error: "no rca snapshot for this session (missing .rca.json sidecar)" });
      }
      return rec.snapshot;
    },
  );
}
