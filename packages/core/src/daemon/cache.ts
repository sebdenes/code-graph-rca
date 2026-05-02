import { spawnSync } from "node:child_process";
import type { Db } from "../graph/db.js";
import type { ExtractedFile } from "../types.js";

/**
 * Blob-sha cache for extracted-file JSON. Keyed by `file_path` — we keep
 * one row per path and overwrite it when the blob sha changes. The shape
 * is set up by the v4 schema migration in `graph/schema.sql`.
 *
 * The win: on a re-index, only files whose `git hash-object` differs from
 * the cached row need to go through tree-sitter. Hitting one dirty file
 * in a 1000-file repo takes ~1 parse instead of 1000.
 */

export interface CachedExtraction {
  blobSha: string;
  extracted: ExtractedFile;
}

export function getCached(db: Db, filePath: string): CachedExtraction | null {
  const row = db
    .prepare(
      "SELECT blob_sha AS blobSha, extracted_json AS json FROM blob_cache WHERE file_path = ?",
    )
    .get(filePath) as { blobSha: string; json: string } | undefined;
  if (!row) return null;
  try {
    return { blobSha: row.blobSha, extracted: JSON.parse(row.json) };
  } catch {
    return null;
  }
}

/**
 * Bulk variant of `getCached` that reads every cache row in a single
 * SELECT and returns blob_sha + raw JSON keyed by file_path. Defers
 * `JSON.parse` to the caller so we only pay the parse on confirmed
 * sha hits — misses skip the parse entirely. This is the hot path
 * for `indexScope` warm runs (one SELECT instead of N).
 */
export function getAllCached(
  db: Db,
): Map<string, { blobSha: string; json: string }> {
  const rows = db
    .prepare(
      "SELECT file_path AS filePath, blob_sha AS blobSha, extracted_json AS json FROM blob_cache",
    )
    .all() as Array<{ filePath: string; blobSha: string; json: string }>;
  const out = new Map<string, { blobSha: string; json: string }>();
  for (const r of rows) out.set(r.filePath, { blobSha: r.blobSha, json: r.json });
  return out;
}

export function putCached(
  db: Db,
  filePath: string,
  blobSha: string,
  extracted: ExtractedFile,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO blob_cache (file_path, blob_sha, extracted_json, cached_at) VALUES (?, ?, ?, ?)",
  ).run(filePath, blobSha, JSON.stringify(extracted), Date.now());
}

/**
 * Compute git blob shas for many files in one process spawn. Returns a
 * map keyed by absolute path. If git is unavailable or the repo isn't a
 * git repo, returns an empty map and the caller should fall back to
 * always-extract (cache disabled).
 */
export function batchHashObjects(
  repoRoot: string,
  absPaths: string[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (absPaths.length === 0) return out;
  const r = spawnSync(
    "git",
    ["-C", repoRoot, "hash-object", "--stdin-paths"],
    {
      input: absPaths.join("\n") + "\n",
      encoding: "utf8",
      // Hashing 10k files is bounded; 30s is generous.
      timeout: 30_000,
    },
  );
  if (r.status !== 0 || typeof r.stdout !== "string") return out;
  const lines = r.stdout.split("\n");
  for (let i = 0; i < absPaths.length; i++) {
    const sha = lines[i];
    if (sha && /^[0-9a-f]{40}$/.test(sha)) {
      out.set(absPaths[i]!, sha);
    }
  }
  return out;
}
