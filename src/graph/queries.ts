import { spawnSync } from "node:child_process";
import type { Db } from "./db.js";
import type {
  CallerNode,
  CallerTree,
  CalleeNode,
  CalleeTree,
  Definition,
  GitChange,
  Language,
  SymbolKind,
  SymbolSummary,
} from "../types.js";
import {
  createRecencyHydrator,
  hydrateCallerTree,
  hydrateCalleeTree,
} from "../rca/recency.js";

export interface DefinitionOptions {
  language?: "typescript" | "python";
  subsystem?: string;
}

export function definitionOf(
  db: Db,
  name: string,
  opts: DefinitionOptions = {},
): Definition[] {
  const clauses: string[] = ["s.name = ?"];
  const params: unknown[] = [name];
  if (opts.language) {
    clauses.push("f.language = ?");
    params.push(opts.language);
  }
  if (opts.subsystem) {
    clauses.push("f.subsystem = ?");
    params.push(opts.subsystem);
  }
  const sql = `
    SELECT s.name, s.kind, f.path, s.start_line, s.end_line, s.signature, s.exported,
           f.language, f.subsystem
      FROM symbols s
      JOIN files f ON f.id = s.file_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY s.exported DESC, f.path ASC, s.start_line ASC
  `;
  const rows = db.prepare(sql).all(...params) as Array<{
    name: string;
    kind: SymbolKind;
    path: string;
    start_line: number;
    end_line: number;
    signature: string | null;
    exported: 0 | 1;
    language: Language;
    subsystem: string;
  }>;
  return rows.map((r) => ({
    name: r.name,
    kind: r.kind,
    file: r.path,
    startLine: r.start_line,
    endLine: r.end_line,
    signature: r.signature,
    exported: r.exported === 1,
    language: r.language,
    subsystem: r.subsystem,
  }));
}

export function symbolsInFile(db: Db, path: string): SymbolSummary[] {
  const rows = db
    .prepare(
      `SELECT s.name, s.kind, s.start_line, s.end_line, s.signature, s.exported
         FROM symbols s
         JOIN files f ON f.id = s.file_id
        WHERE f.path = ?
        ORDER BY s.start_line ASC`,
    )
    .all(path) as Array<{
    name: string;
    kind: SymbolKind;
    start_line: number;
    end_line: number;
    signature: string | null;
    exported: 0 | 1;
  }>;
  return rows.map((r) => ({
    name: r.name,
    kind: r.kind,
    startLine: r.start_line,
    endLine: r.end_line,
    signature: r.signature,
    exported: r.exported === 1,
  }));
}

export interface RecencyHydrationOptions {
  repoRoot: string;
  sinceDays?: number;
  maxCommitsPerSymbol?: number;
  maxLookups?: number;
}

export interface CallerOptions {
  depth?: number;
  minConfidence?: number;
  hydrateRecency?: RecencyHydrationOptions;
}

interface RawCaller {
  caller_id: number;
  caller_name: string;
  caller_path: string;
  call_line: number;
  confidence: number;
}

export function callersOf(
  db: Db,
  name: string,
  opts: CallerOptions = {},
): CallerTree {
  const depth = Math.max(1, Math.min(opts.depth ?? 2, 5));
  const minConf = opts.minConfidence ?? 0.5;

  const seedIds = db
    .prepare("SELECT id FROM symbols WHERE name = ?")
    .all(name) as Array<{ id: number }>;
  const targetIds = new Set(seedIds.map((r) => r.id));
  const visited = new Set<number>();
  const tree: CallerTree = { target: name, callers: [] };

  // Build per-target sub-tree from each seed id, merging at name level.
  const seenByName = new Map<string, CallerNode>();
  for (const id of targetIds) {
    walkUp(db, id, depth, minConf, visited, seenByName, tree.callers);
  }
  if (opts.hydrateRecency) {
    const hydrator = createRecencyHydrator(opts.hydrateRecency);
    hydrateCallerTree(tree, db, hydrator);
  }
  return tree;
}

function walkUp(
  db: Db,
  toId: number,
  depthRemaining: number,
  minConf: number,
  visited: Set<number>,
  seen: Map<string, CallerNode>,
  outList: CallerNode[],
): void {
  if (depthRemaining <= 0) return;
  if (visited.has(toId)) return;
  visited.add(toId);

  const stmt = db.prepare(
    `SELECT e.from_symbol_id AS caller_id, s.name AS caller_name, f.path AS caller_path,
            e.call_line, e.confidence
       FROM edges e
       JOIN symbols s ON s.id = e.from_symbol_id
       JOIN files f ON f.id = s.file_id
      WHERE e.to_symbol_id = ?
        AND e.kind = 'CALLS'
        AND e.confidence >= ?`,
  );
  const callers = stmt.all(toId, minConf) as RawCaller[];

  for (const c of callers) {
    const key = `${c.caller_path}:${c.caller_name}`;
    let node = seen.get(key);
    if (!node) {
      node = {
        name: c.caller_name,
        file: c.caller_path,
        line: c.call_line,
        confidence: c.confidence,
        callers: [],
      };
      seen.set(key, node);
      outList.push(node);
    }
    walkUp(db, c.caller_id, depthRemaining - 1, minConf, visited, seen, node.callers);
  }
}

export interface CalleeOptions {
  depth?: number;
  hydrateRecency?: RecencyHydrationOptions;
}

export function calleesOf(
  db: Db,
  name: string,
  opts: CalleeOptions = {},
): CalleeTree {
  const depth = Math.max(1, Math.min(opts.depth ?? 1, 4));
  const seeds = db
    .prepare("SELECT id FROM symbols WHERE name = ?")
    .all(name) as Array<{ id: number }>;
  const tree: CalleeTree = { source: name, callees: [] };
  const visited = new Set<number>();
  const seen = new Map<string, CalleeNode>();
  for (const s of seeds) {
    walkDown(db, s.id, depth, visited, seen, tree.callees);
  }
  if (opts.hydrateRecency) {
    const hydrator = createRecencyHydrator(opts.hydrateRecency);
    hydrateCalleeTree(tree, db, hydrator);
  }
  return tree;
}

function walkDown(
  db: Db,
  fromId: number,
  depthRemaining: number,
  visited: Set<number>,
  seen: Map<string, CalleeNode>,
  outList: CalleeNode[],
): void {
  if (depthRemaining <= 0) return;
  if (visited.has(fromId)) return;
  visited.add(fromId);

  const rows = db
    .prepare(
      `SELECT e.to_name, e.to_symbol_id, e.confidence, e.call_line, f.path AS to_path
         FROM edges e
         LEFT JOIN symbols s ON s.id = e.to_symbol_id
         LEFT JOIN files f ON f.id = s.file_id
        WHERE e.from_symbol_id = ?
          AND e.kind = 'CALLS'`,
    )
    .all(fromId) as Array<{
      to_name: string;
      to_symbol_id: number | null;
      confidence: number;
      call_line: number | null;
      to_path: string | null;
    }>;

  for (const r of rows) {
    const key = `${r.to_path ?? "?"}:${r.to_name}`;
    let node = seen.get(key);
    if (!node) {
      node = {
        name: r.to_name,
        resolved: r.to_symbol_id !== null,
        file: r.to_path,
        line: r.call_line,
        confidence: r.confidence,
        callees: [],
      };
      seen.set(key, node);
      outList.push(node);
    }
    if (r.to_symbol_id !== null) {
      walkDown(db, r.to_symbol_id, depthRemaining - 1, visited, seen, node.callees);
    }
  }
}

export interface RecentlyChangedNearOptions {
  sinceDays?: number;
  repoRoot?: string;
  maxCommits?: number;
}

interface SymbolLocRow {
  path: string;
  start_line: number;
  end_line: number;
}

export function recentlyChangedNear(
  db: Db,
  name: string,
  opts: RecentlyChangedNearOptions = {},
): GitChange[] {
  const sinceDays = opts.sinceDays ?? 90;
  const maxCommits = opts.maxCommits ?? 20;
  const repoRoot = opts.repoRoot ?? process.cwd();

  const rows = db
    .prepare(
      `SELECT f.path AS path, s.start_line AS start_line, s.end_line AS end_line
         FROM symbols s
         JOIN files f ON f.id = s.file_id
        WHERE s.name = ?
        ORDER BY f.path ASC, s.start_line ASC`,
    )
    .all(name) as SymbolLocRow[];

  if (rows.length === 0) return [];

  // Cap the number of symbol matches we shell out for.
  const SYMBOL_CAP = 5;
  const limited = rows.slice(0, SYMBOL_CAP);

  const collected: GitChange[] = [];

  for (const row of limited) {
    const since = `${sinceDays}.days.ago`;
    const lineRange = `${row.start_line},${row.end_line}:${row.path}`;
    const result = spawnSync(
      "git",
      [
        "-C",
        repoRoot,
        "log",
        `--since=${since}`,
        "-L",
        lineRange,
        "--no-patch",
        "--format=%H%x09%an%x09%aI%x09%s",
        `--max-count=${maxCommits}`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );

    if (result.error) {
      console.warn(
        `recentlyChangedNear: git failed for ${row.path}:${row.start_line}-${row.end_line}: ${result.error.message}`,
      );
      continue;
    }
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").toString().trim().split("\n")[0] ?? "";
      console.warn(
        `recentlyChangedNear: git exit ${result.status} for ${row.path}:${row.start_line}-${row.end_line}: ${stderr}`,
      );
      continue;
    }

    const stdout = result.stdout ?? "";
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const sha = parts[0];
      const author = parts[1];
      const date = parts[2];
      const subject = parts.slice(3).join("\t");
      if (!sha || !author || !date) continue;
      collected.push({
        commit: sha,
        author,
        date,
        subject,
        file: row.path,
        symbolName: name,
      });
    }
  }

  collected.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return collected.slice(0, maxCommits);
}
