import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { BlameLine, BlameResponse } from "../../../shared/api.js";
import type { SessionRecord } from "../sessions.js";
import { resolveSandboxed } from "./source.js";

interface CommitMeta {
  author: string;
  date: string;
  subject: string;
}

/** Parse `git blame --porcelain` output into BlameLine[]. */
export function parsePorcelain(text: string): BlameLine[] {
  const out: BlameLine[] = [];
  const lines = text.split("\n");
  const commits = new Map<string, CommitMeta>();
  let i = 0;
  let pendingCommit: string | null = null;
  let pendingFinalLine: number | null = null;
  let buildingMeta: Partial<CommitMeta> = {};
  while (i < lines.length) {
    const ln = lines[i] ?? "";
    if (!ln) {
      i++;
      continue;
    }
    // Header: <40-hex sha> <orig-line> <final-line> [<group-size>]
    const headerMatch = ln.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/);
    if (headerMatch) {
      pendingCommit = headerMatch[1] ?? null;
      pendingFinalLine = headerMatch[3] ? parseInt(headerMatch[3], 10) : null;
      buildingMeta = {};
      i++;
      // Read header lines until we hit the "\t<content>" line.
      while (i < lines.length) {
        const inner = lines[i] ?? "";
        if (inner.startsWith("\t")) {
          // Content line — emit and move on.
          if (pendingCommit && pendingFinalLine != null) {
            const known = commits.get(pendingCommit);
            const meta: CommitMeta = known ?? {
              author: buildingMeta.author ?? "",
              date: buildingMeta.date ?? "",
              subject: buildingMeta.subject ?? "",
            };
            if (!known) commits.set(pendingCommit, meta);
            out.push({
              line: pendingFinalLine,
              commit: pendingCommit,
              author: meta.author,
              date: meta.date,
              subject: meta.subject,
            });
          }
          i++;
          break;
        }
        if (inner.startsWith("author ")) {
          buildingMeta.author = inner.slice("author ".length);
        } else if (inner.startsWith("author-time ")) {
          const t = parseInt(inner.slice("author-time ".length), 10);
          if (!Number.isNaN(t)) {
            buildingMeta.date = new Date(t * 1000).toISOString();
          }
        } else if (inner.startsWith("summary ")) {
          buildingMeta.subject = inner.slice("summary ".length);
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return out;
}

function isGitRepo(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".git"));
}

export function registerBlameRoute(
  fastify: FastifyInstance,
  sessions: Map<string, SessionRecord>,
): void {
  fastify.get<{ Params: { id: string; "*": string } }>(
    "/api/session/:id/blame/*",
    async (req, reply): Promise<BlameResponse | undefined> => {
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
      if (!isGitRepo(rec.repoRoot)) {
        return { path: sub, lines: [] };
      }
      const r = spawnSync(
        "git",
        ["-C", rec.repoRoot, "blame", "--porcelain", "--", sub],
        { encoding: "utf8", timeout: 10_000 },
      );
      if (r.status !== 0 || !r.stdout) {
        return { path: sub, lines: [] };
      }
      const lines = parsePorcelain(r.stdout);
      return { path: sub, lines };
    },
  );
}
