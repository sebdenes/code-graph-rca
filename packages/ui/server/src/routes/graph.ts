import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  GraphResponse,
  GraphFileNode,
  GraphSymbolNode,
  GraphEdgeRow,
} from "../../../shared/api.js";
import type { SessionRecord } from "../sessions.js";

const DEFAULT_MAX_SYMBOLS = 800;
const BODY_PREVIEW_LINES = 10;
const BODY_PREVIEW_CHAR_CAP = 600;

/**
 * `GET /api/session/:id/graph` — the full code knowledge graph for the indexed
 * scope. Returned independently of any RCA invocation.
 *
 * Each symbol carries a `bodyPreview` slurped from disk so frontend nodes can
 * render real code without an extra request per node. Capped at the first
 * BODY_PREVIEW_LINES lines and BODY_PREVIEW_CHAR_CAP characters.
 */
export function registerGraphRoute(
  fastify: FastifyInstance,
  sessions: Map<string, SessionRecord>,
): void {
  fastify.get<{ Params: { id: string }; Querystring: { maxSymbols?: string } }>(
    "/api/session/:id/graph",
    async (req, reply) => {
      const rec = sessions.get(req.params.id);
      if (!rec) {
        return reply.code(404).send({ error: "session not found" });
      }
      const maxSymbols = clampInt(req.query.maxSymbols, 50, 5000, DEFAULT_MAX_SYMBOLS);

      // Symbols ordered by exported then loc DESC so prominent symbols dominate
      // the truncation cut.
      const symbolRows = rec.db
        .prepare(
          `SELECT s.id, s.name, s.kind, s.file_id AS file_id,
                  s.start_line, s.end_line, s.signature, s.exported,
                  parent.name AS parent_name
             FROM symbols s
             LEFT JOIN symbols parent ON parent.id = s.parent_id
            ORDER BY s.exported DESC, (s.end_line - s.start_line) DESC
            LIMIT ?`,
        )
        .all(maxSymbols) as Array<{
          id: number;
          name: string;
          kind: GraphSymbolNode["kind"];
          file_id: number;
          start_line: number;
          end_line: number;
          signature: string | null;
          exported: 0 | 1;
          parent_name: string | null;
        }>;

      const totalSymbols = (rec.db.prepare("SELECT count(*) AS n FROM symbols").get() as { n: number }).n;
      const truncated = symbolRows.length < totalSymbols;

      const symbolIds = new Set(symbolRows.map((r) => r.id));

      // Only return files referenced by the symbols in scope. Returning every
      // indexed file (a 28k-symbol Python repo = 6903) was the actual unresponsiveness
      // cause: Cytoscape held ~7400 nodes even when maxSymbols capped at 400,
      // because file + folder nodes were unbounded. With this filter the file
      // count tracks the scope, and folder nodes (synthesized client-side
      // from file paths) follow.
      const fileIdsInScope = new Set(symbolRows.map((r) => r.file_id));
      const fileRows =
        fileIdsInScope.size === 0
          ? []
          : (rec.db
              .prepare(
                `SELECT id, path, language, subsystem, loc FROM files
                  WHERE language != 'unparsed'
                    AND id IN (${[...fileIdsInScope].map(() => "?").join(",")})
                  ORDER BY loc DESC, path ASC`,
              )
              .all(...fileIdsInScope) as Array<{
                id: number;
                path: string;
                language: GraphFileNode["language"];
                subsystem: string;
                loc: number;
              }>);
      const files = fileRows.map((r) => ({ ...r }));
      const filesById = new Map(files.map((f) => [f.id, f.path]));

      const symbols: GraphSymbolNode[] = symbolRows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        fileId: r.file_id,
        startLine: r.start_line,
        endLine: r.end_line,
        signature: r.signature,
        exported: r.exported === 1,
        parentName: r.parent_name,
        bodyPreview: rec.repoRoot
          ? sliceBody(rec.repoRoot, filesById.get(r.file_id), r.start_line, r.end_line)
          : "",
      }));

      // Only include edges connecting symbols still in the response set.
      const edgeRows = rec.db
        .prepare(
          `SELECT id, from_symbol_id, to_symbol_id, to_name, kind, confidence, call_line
             FROM edges
            WHERE kind IN ('CALLS', 'EXTENDS', 'IMPLEMENTS')`,
        )
        .all() as Array<{
          id: number;
          from_symbol_id: number;
          to_symbol_id: number | null;
          to_name: string;
          kind: GraphEdgeRow["kind"];
          confidence: number;
          call_line: number | null;
        }>;

      const edges: GraphEdgeRow[] = edgeRows
        .filter((e) => symbolIds.has(e.from_symbol_id))
        .map((e) => ({
          id: e.id,
          fromSymbolId: e.from_symbol_id,
          toSymbolId: e.to_symbol_id !== null && symbolIds.has(e.to_symbol_id) ? e.to_symbol_id : null,
          toName: e.to_name,
          kind: e.kind,
          confidence: e.confidence,
          callLine: e.call_line,
        }));

      const response: GraphResponse = { files, symbols, edges, truncated };
      return response;
    },
  );
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "string" ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sliceBody(repoRoot: string, relPath: string | undefined, startLine: number, endLine: number): string {
  if (!relPath) return "";
  try {
    const text = readFileSync(join(repoRoot, relPath), "utf8");
    const lines = text.split("\n");
    const last = Math.min(endLine, startLine + BODY_PREVIEW_LINES - 1, lines.length);
    const slice = lines.slice(startLine - 1, last).join("\n");
    if (slice.length > BODY_PREVIEW_CHAR_CAP) return slice.slice(0, BODY_PREVIEW_CHAR_CAP) + "\n…";
    return slice;
  } catch {
    return "";
  }
}
