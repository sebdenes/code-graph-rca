import type { FastifyInstance } from "fastify";
import { runRca } from "code-graph-rca";
import type { FailureScope } from "code-graph-rca";
import type { RcaQuery } from "../../../shared/api.js";
import type { SessionRecord } from "../sessions.js";

export function registerRcaRoute(
  fastify: FastifyInstance,
  sessions: Map<string, SessionRecord>,
): void {
  // GET — backward-compat snapshot loader (kept for MCP publishSelection flow)
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

  // POST — live RCA query, no sidecar needed
  fastify.post<{ Params: { id: string }; Body: RcaQuery }>(
    "/api/session/:id/rca",
    async (req, reply) => {
      const rec = sessions.get(req.params.id);
      if (!rec) {
        return reply.code(404).send({ error: "session not found" });
      }
      if (!rec.repoRoot) {
        return reply.code(400).send({ error: "session has no repo root — re-index with cgrca daemon start" });
      }

      const { failure, budget } = req.body ?? {};
      if (!failure?.kind) {
        return reply.code(400).send({ error: "failure.kind required" });
      }

      // Map the wire shape to the FailureScope union
      let failureScope: FailureScope;
      switch (failure.kind) {
        case "symbol":
          if (!failure.name) return reply.code(400).send({ error: "failure.name required for kind=symbol" });
          failureScope = { kind: "symbol", name: failure.name, ...(failure.file ? { file: failure.file } : {}) };
          break;
        case "file":
          if (!failure.path) return reply.code(400).send({ error: "failure.path required for kind=file" });
          failureScope = { kind: "file", path: failure.path };
          break;
        case "failing-test":
          if (!failure.path) return reply.code(400).send({ error: "failure.path required for kind=failing-test" });
          failureScope = { kind: "failing-test", path: failure.path, ...(failure.testName ? { testName: failure.testName } : {}) };
          break;
        case "stack-trace":
          if (!failure.text) return reply.code(400).send({ error: "failure.text required for kind=stack-trace" });
          failureScope = { kind: "stack-trace", text: failure.text };
          break;
        default:
          return reply.code(400).send({ error: `unknown failure kind: ${String((failure as { kind: string }).kind)}` });
      }

      try {
        const result = await runRca({
          failureScope,
          repoRoot: rec.repoRoot,
          ...(budget ? { budget } : {}),
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reply.code(500).send({ error: msg });
        return undefined;
      }
    },
  );
}
