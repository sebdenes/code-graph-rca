import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Body-fetcher helper for v0.5 Phase 2.
 *
 * Reads a slice of a source file relative to the repo root and clips it to
 * `maxLines` so a candidate's body fits within the LLM token budget. We
 * deliberately don't go through the cgrca SQLite cache here — the cache
 * stores symbol metadata, not raw source. Reading from disk is cheap and
 * keeps the layering simple.
 */

export interface BodySnippet {
  /** Raw source slice, no header. */
  body: string;
  /** Inclusive 1-based line range that was actually returned. */
  startLine: number;
  endLine: number;
  /** True if the symbol's full body extended past `maxLines`. */
  truncated: boolean;
  /** Detected file extension language hint (`python`, `typescript`, …). */
  language: string;
}

const LANG_BY_EXT: Record<string, string> = {
  ".py": "python",
  ".pyi": "python",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

function langOf(file: string): string {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return "text";
  return LANG_BY_EXT[file.slice(dot).toLowerCase()] ?? "text";
}

/**
 * Slice the source file at `[startLine, endLine]`. If the slice exceeds
 * `maxLines`, return the first `maxLines` and set `truncated`.
 *
 * Returns `null` when the file doesn't exist (e.g. moved/deleted between
 * indexing and the LLM call). Caller should warn + skip that candidate.
 */
export function fetchBody(
  repoRoot: string,
  file: string,
  startLine: number,
  endLine: number,
  maxLines: number,
): BodySnippet | null {
  if (!file) return null;
  const abs = join(repoRoot, file);
  if (!existsSync(abs)) return null;
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  // Clamp range to the file. If startLine is bogus (>file length), fall back
  // to the first few lines so we at least get something to show the LLM.
  const lo = Math.max(1, Math.min(startLine, lines.length));
  const hiRequested = Math.max(lo, Math.min(endLine, lines.length));
  const span = hiRequested - lo + 1;
  const truncated = span > maxLines;
  const hi = truncated ? lo + maxLines - 1 : hiRequested;
  return {
    body: lines.slice(lo - 1, hi).join("\n"),
    startLine: lo,
    endLine: hi,
    truncated,
    language: langOf(file),
  };
}
