import { spawnSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import type { DiffResponse } from "../../../shared/api.js";
import type { SessionRecord } from "../sessions.js";

const HEADER_END = "---END-HEADER---";

interface ParsedHeader {
  commit: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  /** lines from --stat */
  statLines: string[];
}

export function parseHeaderAndStat(text: string): ParsedHeader {
  // Layout: <hash>\n<author>\n<iso-date>\n<subject>\n<body...>\n<HEADER_END>\n<stat>\n
  const idx = text.indexOf(HEADER_END);
  const headerBlock = idx === -1 ? text : text.slice(0, idx);
  const tail = idx === -1 ? "" : text.slice(idx + HEADER_END.length).replace(/^\n+/, "");
  const headerLines = headerBlock.split("\n");
  const commit = headerLines[0] ?? "";
  const author = headerLines[1] ?? "";
  const date = headerLines[2] ?? "";
  const subject = headerLines[3] ?? "";
  // Drop trailing blank lines on the body.
  const bodyLines = headerLines.slice(4);
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") {
    bodyLines.pop();
  }
  const body = bodyLines.join("\n");
  const statLines = tail.split("\n").filter((l) => l.length > 0);
  return { commit, author, date, subject, body, statLines };
}

interface FileStats {
  additions: number;
  deletions: number;
}

/** Parse `git show --numstat` lines into a path->stats map. */
function parseNumstat(text: string): Map<string, FileStats> {
  const m = new Map<string, FileStats>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // <add>\t<del>\t<path>   (binary files use "-" for both)
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const adds = parts[0];
    const dels = parts[1];
    const path = parts.slice(2).join("\t");
    const a = adds === "-" ? 0 : parseInt(adds ?? "0", 10);
    const d = dels === "-" ? 0 : parseInt(dels ?? "0", 10);
    m.set(path, {
      additions: Number.isNaN(a) ? 0 : a,
      deletions: Number.isNaN(d) ? 0 : d,
    });
  }
  return m;
}

/** Split a unified-diff blob into per-file patches keyed by the b/<path>. */
export function splitPatches(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!diff) return out;
  const blocks = diff.split(/^diff --git /m).filter((b) => b.length > 0);
  for (const block of blocks) {
    const full = "diff --git " + block;
    // First line: `a/<path> b/<path>`. Path may contain spaces.
    const firstLine = full.split("\n", 1)[0] ?? "";
    const m = firstLine.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!m) continue;
    const path = m[2] ?? m[1] ?? "";
    if (!path) continue;
    out.set(path, full.endsWith("\n") ? full : full + "\n");
  }
  return out;
}

export function registerDiffRoute(
  fastify: FastifyInstance,
  sessions: Map<string, SessionRecord>,
): void {
  fastify.get<{ Params: { id: string; sha: string } }>(
    "/api/session/:id/diff/:sha",
    async (req, reply): Promise<DiffResponse | undefined> => {
      const rec = sessions.get(req.params.id);
      if (!rec) {
        reply.code(404).send({ error: "session not found" });
        return undefined;
      }
      if (!rec.repoRoot) {
        reply.code(404).send({ error: "session has no repoRoot" });
        return undefined;
      }
      const sha = req.params.sha;
      // Only allow hex shas (no flag injection).
      if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) {
        reply.code(400).send({ error: "invalid sha" });
        return undefined;
      }

      const headerArgs = [
        "-C",
        rec.repoRoot,
        "show",
        "--no-patch",
        `--format=%H%n%an%n%aI%n%s%n%b%n${HEADER_END}`,
        sha,
      ];
      const headerRes = spawnSync("git", headerArgs, {
        encoding: "utf8",
        timeout: 10_000,
      });
      if (headerRes.status !== 0) {
        reply.code(404).send({
          error: "commit not found",
          stderr: (headerRes.stderr ?? "").trim(),
        });
        return undefined;
      }
      const parsed = parseHeaderAndStat(headerRes.stdout ?? "");

      // Per-file numstat for additions/deletions.
      const numRes = spawnSync(
        "git",
        ["-C", rec.repoRoot, "show", "--numstat", "--format=", sha],
        { encoding: "utf8", timeout: 10_000 },
      );
      const stats = parseNumstat(numRes.stdout ?? "");

      // Per-file patches.
      const patchRes = spawnSync(
        "git",
        ["-C", rec.repoRoot, "show", "--unified=3", "--format=", sha],
        { encoding: "utf8", timeout: 10_000 },
      );
      const patches = splitPatches(patchRes.stdout ?? "");

      const filePaths = new Set<string>([...stats.keys(), ...patches.keys()]);
      const files: DiffResponse["files"] = [];
      for (const p of filePaths) {
        const s = stats.get(p) ?? { additions: 0, deletions: 0 };
        files.push({
          path: p,
          additions: s.additions,
          deletions: s.deletions,
          patch: patches.get(p) ?? "",
        });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));

      return {
        commit: parsed.commit,
        author: parsed.author,
        date: parsed.date,
        subject: parsed.subject,
        body: parsed.body,
        files,
      };
    },
  );
}
