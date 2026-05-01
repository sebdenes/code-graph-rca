import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Language } from "code-graph-rca";
import type { SourceResponse } from "../../../shared/api.js";
import type { SessionRecord } from "../sessions.js";

function languageOf(path: string): Language {
  const ext = extname(path).toLowerCase();
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    return "typescript";
  }
  if (ext === ".py" || ext === ".pyi") return "python";
  return "unparsed";
}

/** Resolve a relative subpath inside a sandbox. Returns null if it escapes. */
export function resolveSandboxed(repoRoot: string, sub: string): string | null {
  if (!sub) return null;
  // Reject any absolute path or null bytes / suspicious chars.
  if (sub.includes("\0")) return null;
  if (isAbsolute(sub)) return null;
  const root = resolve(repoRoot);
  const full = resolve(root, sub);
  // Normalize trailing separators and verify containment.
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(rootWithSep)) return null;
  return full;
}

export function registerSourceRoute(
  fastify: FastifyInstance,
  sessions: Map<string, SessionRecord>,
): void {
  fastify.get<{ Params: { id: string; "*": string } }>(
    "/api/session/:id/source/*",
    async (req, reply): Promise<SourceResponse | undefined> => {
      const rec = sessions.get(req.params.id);
      if (!rec) {
        reply.code(404).send({ error: "session not found" });
        return undefined;
      }
      if (!rec.repoRoot) {
        reply.code(404).send({ error: "session has no repoRoot" });
        return undefined;
      }
      const sub = req.params["*"];
      const abs = resolveSandboxed(rec.repoRoot, sub);
      if (!abs) {
        reply.code(400).send({ error: "invalid path" });
        return undefined;
      }
      if (!existsSync(abs)) {
        reply.code(404).send({ error: "file not found" });
        return undefined;
      }
      const st = statSync(abs);
      if (!st.isFile()) {
        reply.code(400).send({ error: "not a file" });
        return undefined;
      }
      // Read file as utf8. For huge binaries you'd want a streaming guard,
      // but the indexed scope is all source so we accept it.
      const content = readFileSync(abs, "utf8");
      const loc = content.length === 0 ? 0 : content.split("\n").length;
      return {
        path: sub,
        language: languageOf(sub),
        content,
        loc,
      };
    },
  );
}
