import { spawnSync } from "node:child_process";
import type { Db } from "../graph/db.js";
import type {
  CallerNode,
  CallerTree,
  CalleeNode,
  CalleeTree,
  RecentChange,
} from "../types.js";

export interface RecencyOptions {
  repoRoot: string;
  sinceDays?: number;
  maxCommitsPerSymbol?: number;
  /** Cap total git invocations per session — recency is best-effort. */
  maxLookups?: number;
}

export interface RecencyHydrator {
  /** Fetch recent changes for a symbol at file:start-end. Cached per (file, start, end). */
  fetch(file: string, startLine: number, endLine: number): RecentChange[];
  /** Number of git invocations performed. */
  readonly invocations: number;
  /** Number that hit the cache. */
  readonly cacheHits: number;
}

const DEFAULT_SINCE_DAYS = 90;
const DEFAULT_MAX_COMMITS_PER_SYMBOL = 3;
const DEFAULT_MAX_LOOKUPS = 50;
const PER_CALL_TIMEOUT_MS = 3000;

export function createRecencyHydrator(opts: RecencyOptions): RecencyHydrator {
  const repoRoot = opts.repoRoot;
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const maxCommitsPerSymbol =
    opts.maxCommitsPerSymbol ?? DEFAULT_MAX_COMMITS_PER_SYMBOL;
  const maxLookups = opts.maxLookups ?? DEFAULT_MAX_LOOKUPS;

  const cache = new Map<string, RecentChange[]>();
  let invocations = 0;
  let cacheHits = 0;

  const hydrator: RecencyHydrator = {
    fetch(file: string, startLine: number, endLine: number): RecentChange[] {
      const key = `${file}:${startLine}:${endLine}`;
      const cached = cache.get(key);
      if (cached) {
        cacheHits++;
        return cached;
      }
      if (invocations >= maxLookups) {
        const empty: RecentChange[] = [];
        cache.set(key, empty);
        return empty;
      }
      invocations++;
      const changes = runGitLog(
        repoRoot,
        file,
        startLine,
        endLine,
        sinceDays,
        maxCommitsPerSymbol,
      );
      cache.set(key, changes);
      return changes;
    },
    get invocations(): number {
      return invocations;
    },
    get cacheHits(): number {
      return cacheHits;
    },
  };
  return hydrator;
}

function runGitLog(
  repoRoot: string,
  file: string,
  startLine: number,
  endLine: number,
  sinceDays: number,
  maxCommits: number,
): RecentChange[] {
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return [];
  if (startLine < 1 || endLine < startLine) return [];

  try {
    const lineRange = `${startLine},${endLine}:${file}`;
    const result = spawnSync(
      "git",
      [
        "-C",
        repoRoot,
        "log",
        `--since=${sinceDays}.days.ago`,
        "-L",
        lineRange,
        "--no-patch",
        "--format=%H%x09%an%x09%aI%x09%s",
        `--max-count=${maxCommits}`,
      ],
      { encoding: "utf8", timeout: PER_CALL_TIMEOUT_MS },
    );

    if (result.error) return [];
    if (result.status !== 0) return [];

    const stdout = result.stdout ?? "";
    const out: RecentChange[] = [];
    const now = Date.now();
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const sha = parts[0];
      const author = parts[1];
      const date = parts[2];
      const subject = parts.slice(3).join("\t");
      if (!sha || !author || !date) continue;
      const parsed = Date.parse(date);
      const daysAgo = Number.isFinite(parsed)
        ? Math.round((now - parsed) / 86400000)
        : 0;
      out.push({
        commit: sha,
        date,
        author,
        subject,
        daysAgo,
      });
      if (out.length >= maxCommits) break;
    }
    return out;
  } catch {
    return [];
  }
}

interface SymbolLocRow {
  start_line: number;
  end_line: number;
}

function lookupRange(
  db: Db,
  file: string,
  name: string,
): { startLine: number; endLine: number } | null {
  try {
    const row = db
      .prepare(
        `SELECT s.start_line AS start_line, s.end_line AS end_line
           FROM symbols s
           JOIN files f ON f.id = s.file_id
          WHERE f.path = ? AND s.name = ?
          ORDER BY s.start_line ASC
          LIMIT 1`,
      )
      .get(file, name) as SymbolLocRow | undefined;
    if (!row) return null;
    return { startLine: row.start_line, endLine: row.end_line };
  } catch {
    return null;
  }
}

/** Walk a CallerTree and attach recentChanges to every node in place. Idempotent. */
export function hydrateCallerTree(
  tree: CallerTree,
  db: Db,
  hydrator: RecencyHydrator,
): CallerTree {
  for (const node of tree.callers) {
    hydrateCallerNode(node, db, hydrator);
  }
  return tree;
}

function hydrateCallerNode(
  node: CallerNode,
  db: Db,
  hydrator: RecencyHydrator,
): void {
  const range = lookupRange(db, node.file, node.name);
  if (range) {
    node.recentChanges = hydrator.fetch(
      node.file,
      range.startLine,
      range.endLine,
    );
  } else {
    node.recentChanges = [];
  }
  for (const child of node.callers) {
    hydrateCallerNode(child, db, hydrator);
  }
}

/** Walk a CalleeTree similarly. */
export function hydrateCalleeTree(
  tree: CalleeTree,
  db: Db,
  hydrator: RecencyHydrator,
): CalleeTree {
  for (const node of tree.callees) {
    hydrateCalleeNode(node, db, hydrator);
  }
  return tree;
}

function hydrateCalleeNode(
  node: CalleeNode,
  db: Db,
  hydrator: RecencyHydrator,
): void {
  if (node.resolved && node.file) {
    const range = lookupRange(db, node.file, node.name);
    if (range) {
      node.recentChanges = hydrator.fetch(
        node.file,
        range.startLine,
        range.endLine,
      );
    } else {
      node.recentChanges = [];
    }
  } else {
    node.recentChanges = [];
  }
  for (const child of node.callees) {
    hydrateCalleeNode(child, db, hydrator);
  }
}
