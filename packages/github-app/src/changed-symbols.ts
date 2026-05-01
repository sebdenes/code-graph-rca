import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { symbolsInFile, type SymbolSummary } from "code-graph-rca";
import type { Db } from "./types.js";

/** Range of changed lines in a file (1-indexed, inclusive). */
export interface ChangedHunk {
  startLine: number;
  endLine: number;
}

/** A file in the PR diff with its changed line ranges. */
export interface ChangedFile {
  /** Repo-relative path. */
  path: string;
  /** Hunks describing changed line ranges in the new file. Empty for added files (treat as fully changed). */
  hunks: ChangedHunk[];
  /** "added" | "modified" | "removed" | "renamed" — anything else we treat as modified. */
  status?: string;
}

/** A symbol that overlaps a changed line range. */
export interface ChangedSymbol {
  /** Repo-relative file path (in the PR head). */
  file: string;
  /** Symbol name. */
  name: string;
  /** Symbol kind. */
  kind: SymbolSummary["kind"];
  startLine: number;
  endLine: number;
}

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

function isSupportedSourceFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return SUPPORTED_EXTS.has(path.slice(dot));
}

/**
 * Parse a unified-diff `patch` field (as returned by GitHub's compareCommits or
 * pulls/{n}/files endpoint) into changed hunks for the new file.
 */
export function parseHunksFromPatch(patch: string | null | undefined): ChangedHunk[] {
  if (!patch) return [];
  const out: ChangedHunk[] = [];
  // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) {
    const startStr = m[1];
    const lenStr = m[2];
    if (!startStr) continue;
    const start = parseInt(startStr, 10);
    const len = lenStr ? parseInt(lenStr, 10) : 1;
    if (!Number.isFinite(start) || !Number.isFinite(len) || len <= 0) continue;
    out.push({ startLine: start, endLine: start + len - 1 });
  }
  return out;
}

interface OverlapInputs {
  symbol: SymbolSummary;
  hunks: ChangedHunk[];
}

function symbolOverlapsAnyHunk({ symbol, hunks }: OverlapInputs): boolean {
  if (hunks.length === 0) return true;
  for (const h of hunks) {
    if (symbol.startLine <= h.endLine && symbol.endLine >= h.startLine) return true;
  }
  return false;
}

export interface ChangedSymbolsArgs {
  db: Db;
  /** Worktree root; used to verify file existence. */
  repoRoot: string;
  /** Files changed in the PR. */
  files: ChangedFile[];
}

/**
 * For each changed file in the PR, find top-level symbols (function / method /
 * class) that overlap any changed line range. Files outside the indexed scope
 * or with unsupported extensions are skipped silently.
 */
export function findChangedSymbols(args: ChangedSymbolsArgs): ChangedSymbol[] {
  const out: ChangedSymbol[] = [];
  for (const f of args.files) {
    if (!isSupportedSourceFile(f.path)) continue;
    if (f.status === "removed") continue;
    if (!existsSync(join(args.repoRoot, f.path))) continue;

    const syms = symbolsInFile(args.db, f.path);
    for (const s of syms) {
      if (s.kind !== "function" && s.kind !== "method" && s.kind !== "class") continue;
      if (!symbolOverlapsAnyHunk({ symbol: s, hunks: f.hunks })) continue;
      out.push({
        file: f.path,
        name: s.name,
        kind: s.kind,
        startLine: s.startLine,
        endLine: s.endLine,
      });
    }
  }
  return out;
}

/** Read a file relative to a worktree, returning null on error. */
export function safeReadFile(repoRoot: string, rel: string): string | null {
  try {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}
