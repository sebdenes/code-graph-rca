import type { FastifyInstance } from "fastify";
import { buildImpact } from "code-graph-rca";
import type {
  ImpactRequest,
  ImpactResponse,
} from "../../../shared/api.js";
import type { SessionRecord } from "../sessions.js";

export function registerImpactRoute(
  fastify: FastifyInstance,
  sessions: Map<string, SessionRecord>,
): void {
  fastify.post<{ Params: { id: string }; Body: ImpactRequest }>(
    "/api/session/:id/impact",
    async (req, reply): Promise<ImpactResponse | undefined> => {
      const rec = sessions.get(req.params.id);
      if (!rec) {
        reply.code(404).send({ error: "session not found" });
        return undefined;
      }
      const body = req.body;
      if (!body || typeof body.symbolName !== "string" || body.symbolName.length === 0) {
        reply.code(400).send({ error: "symbolName required" });
        return undefined;
      }

      try {
        const result = buildImpact({
          symbolName: body.symbolName,
          ...(typeof body.file === "string" ? { file: body.file } : {}),
          ...(typeof body.depth === "number" ? { depth: body.depth } : {}),
          repoRoot: rec.repoRoot,
          db: rec.db,
        });
        return result as ImpactResponse;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("symbol not found")) {
          reply.code(404).send({ error: msg });
          return undefined;
        }
        reply.code(400).send({ error: msg });
        return undefined;
      }
    },
  );
}
