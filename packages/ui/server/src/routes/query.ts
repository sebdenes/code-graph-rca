import type { FastifyInstance } from "fastify";
import {
  callersOf,
  calleesOf,
  definitionOf,
  recentlyChangedNear,
  symbolsInFile,
} from "code-graph-rca";
import type {
  QueryRequest,
  QueryResponse,
} from "../../../shared/api.js";
import type { SessionRecord } from "../sessions.js";

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function registerQueryRoute(
  fastify: FastifyInstance,
  sessions: Map<string, SessionRecord>,
): void {
  fastify.post<{ Params: { id: string }; Body: QueryRequest }>(
    "/api/session/:id/query",
    async (req, reply) => {
      const rec = sessions.get(req.params.id);
      if (!rec) return reply.code(404).send({ error: "session not found" });
      const body = req.body;
      if (!body || typeof body !== "object" || typeof body.name !== "string") {
        return reply.code(400).send({ error: "invalid query body" });
      }
      const args = (body.args ?? {}) as Record<string, unknown>;
      const db = rec.db;
      try {
        switch (body.name) {
          case "definitionOf": {
            const name = asString(args.name);
            if (!name) return reply.code(400).send({ error: "args.name required" });
            const opts: { language?: "typescript" | "python"; subsystem?: string } = {};
            const lang = asString(args.language);
            if (lang === "typescript" || lang === "python") opts.language = lang;
            const subsystem = asString(args.subsystem);
            if (subsystem) opts.subsystem = subsystem;
            const result = definitionOf(db, name, opts);
            const out: QueryResponse = { name: "definitionOf", result };
            return out;
          }
          case "callersOf": {
            const name = asString(args.name);
            if (!name) return reply.code(400).send({ error: "args.name required" });
            const opts: { depth?: number; minConfidence?: number } = {};
            const depth = asNumber(args.depth);
            if (depth !== undefined) opts.depth = depth;
            const minC = asNumber(args.minConfidence);
            if (minC !== undefined) opts.minConfidence = minC;
            const result = callersOf(db, name, opts);
            const out: QueryResponse = { name: "callersOf", result };
            return out;
          }
          case "calleesOf": {
            const name = asString(args.name);
            if (!name) return reply.code(400).send({ error: "args.name required" });
            const opts: { depth?: number } = {};
            const depth = asNumber(args.depth);
            if (depth !== undefined) opts.depth = depth;
            const result = calleesOf(db, name, opts);
            const out: QueryResponse = { name: "calleesOf", result };
            return out;
          }
          case "symbolsInFile": {
            const path = asString(args.path);
            if (!path) return reply.code(400).send({ error: "args.path required" });
            const result = symbolsInFile(db, path);
            const out: QueryResponse = { name: "symbolsInFile", result };
            return out;
          }
          case "recentlyChangedNear": {
            const name = asString(args.name);
            if (!name) return reply.code(400).send({ error: "args.name required" });
            const opts: { sinceDays?: number; repoRoot?: string; maxCommits?: number } = {};
            const sinceDays = asNumber(args.sinceDays);
            if (sinceDays !== undefined) opts.sinceDays = sinceDays;
            const maxCommits = asNumber(args.maxCommits);
            if (maxCommits !== undefined) opts.maxCommits = maxCommits;
            if (rec.repoRoot) opts.repoRoot = rec.repoRoot;
            const result = recentlyChangedNear(db, name, opts);
            const out: QueryResponse = { name: "recentlyChangedNear", result };
            return out;
          }
          default:
            return reply.code(400).send({ error: `unknown query: ${String(body.name)}` });
        }
      } catch (err) {
        return reply
          .code(500)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
