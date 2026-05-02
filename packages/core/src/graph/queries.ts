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
  PathEdgeKind,
  PathStep,
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
      `SELECT e.to_name, e.to_symbol_id, e.confidence, e.call_line, e.resolution_kind, f.path AS to_path
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
      resolution_kind: import("../types.js").ResolutionKind | null;
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
        resolutionKind: r.resolution_kind,
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
      // `author` is decorative — squash-merge bots, anonymous contributors,
      // and malformed `.mailmap` files can yield an empty %an. Causal scoring
      // only depends on sha + date, so accept the commit and surface
      // "unknown" rather than silently dropping a real candidate.
      if (!sha || !date) continue;
      collected.push({
        commit: sha,
        author: author && author.length > 0 ? author : "unknown",
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

export interface PathBetweenOptions {
  /** Maximum number of edges to traverse before giving up. Default 5. */
  maxDepth?: number;
}

interface SymbolMeta {
  id: number;
  name: string;
  file: string;
  startLine: number;
}

/**
 * BFS over the union of CALLS edges and arg-binding flow edges.
 *
 * Edge model:
 * - CALLS: from caller symbol → callee symbol (resolved edges only).
 * - ARG_BIND: from a *producer* symbol → the caller's enclosing function/method.
 *   Rationale: when `caller(userId)` invokes `callee(userId)` and `userId`
 *   resolves back to some producer symbol (a const, an exported function,
 *   etc.), data is flowing producer → caller. We treat the directionality as
 *   producer → caller so that traversing from a value's source toward where
 *   it's consumed is one BFS step.
 *
 * Returns the shortest sequence of symbols joining `fromName` and `toName`.
 * Each step records how it was reached from the previous one (`edgeKind`)
 * and the call site line for CALLS hops where available. The seed step has
 * `edgeKind: null`.
 */
export function pathBetween(
  db: Db,
  fromName: string,
  toName: string,
  opts: PathBetweenOptions = {},
): PathStep[] | null {
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 5, 10));

  const lookupByName = db.prepare(
    `SELECT s.id, s.name, f.path AS file, s.start_line AS startLine
       FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE s.name = ?`,
  );
  const fromSeeds = lookupByName.all(fromName) as SymbolMeta[];
  const toSeedSet = new Set(
    (lookupByName.all(toName) as SymbolMeta[]).map((r) => r.id),
  );
  if (fromSeeds.length === 0 || toSeedSet.size === 0) return null;

  // Per-step neighbor query: outgoing CALLS edges resolved to a target.
  const callsOut = db.prepare(
    `SELECT e.to_symbol_id AS id, e.call_line AS callLine
       FROM edges e
      WHERE e.from_symbol_id = ?
        AND e.kind = 'CALLS'
        AND e.to_symbol_id IS NOT NULL`,
  );
  // Outgoing arg-binding flow edge: this symbol is a producer that flows
  // into the caller of any call site where it appears as an identifier arg.
  // We hop from `?` (producer) to the caller-side symbol (`from_symbol_id`
  // of the edge whose arg references the producer).
  const argFlowOut = db.prepare(
    `SELECT DISTINCT e.from_symbol_id AS id
       FROM arg_bindings ab
       JOIN edges e ON e.id = ab.edge_id
      WHERE ab.source_symbol_id = ?
        AND ab.source_kind = 'identifier'`,
  );
  const symMeta = db.prepare(
    `SELECT s.id, s.name, f.path AS file, s.start_line AS startLine
       FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE s.id = ?`,
  );

  // BFS: parents[childId] = { parent, edgeKind, edgeLine }
  interface Crumb {
    parent: number;
    edgeKind: PathEdgeKind;
    edgeLine: number | null;
  }
  const parents = new Map<number, Crumb>();
  const queue: Array<{ id: number; depth: number }> = [];
  const seedIds: number[] = [];
  for (const s of fromSeeds) {
    if (toSeedSet.has(s.id)) {
      // Trivial same-symbol match.
      return [
        { name: s.name, file: s.file, line: s.startLine, edgeKind: null },
      ];
    }
    queue.push({ id: s.id, depth: 0 });
    parents.set(s.id, { parent: -1, edgeKind: "CALLS", edgeLine: null });
    seedIds.push(s.id);
  }

  let goalId: number | null = null;
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    const callRows = callsOut.all(id) as Array<{
      id: number | null;
      callLine: number | null;
    }>;
    for (const r of callRows) {
      if (r.id === null) continue;
      if (parents.has(r.id)) continue;
      parents.set(r.id, {
        parent: id,
        edgeKind: "CALLS",
        edgeLine: r.callLine,
      });
      if (toSeedSet.has(r.id)) {
        goalId = r.id;
        break;
      }
      queue.push({ id: r.id, depth: depth + 1 });
    }
    if (goalId !== null) break;
    const flowRows = argFlowOut.all(id) as Array<{ id: number }>;
    for (const r of flowRows) {
      if (parents.has(r.id)) continue;
      parents.set(r.id, {
        parent: id,
        edgeKind: "ARG_BIND",
        edgeLine: null,
      });
      if (toSeedSet.has(r.id)) {
        goalId = r.id;
        break;
      }
      queue.push({ id: r.id, depth: depth + 1 });
    }
    if (goalId !== null) break;
  }

  if (goalId === null) return null;

  // Reconstruct.
  const reverse: Array<{ id: number; edgeKind: PathEdgeKind | null; line: number | null }> = [];
  let cursor: number | null = goalId;
  while (cursor !== null && cursor !== -1) {
    const crumb = parents.get(cursor);
    if (!crumb) break;
    const isSeed = crumb.parent === -1;
    reverse.push({
      id: cursor,
      edgeKind: isSeed ? null : crumb.edgeKind,
      line: isSeed ? null : crumb.edgeLine,
    });
    cursor = isSeed ? null : crumb.parent;
  }
  reverse.reverse();
  return reverse.map((step) => {
    const meta = symMeta.get(step.id) as SymbolMeta | undefined;
    return {
      name: meta?.name ?? "?",
      file: meta?.file ?? null,
      line: step.line ?? meta?.startLine ?? null,
      edgeKind: step.edgeKind,
    };
  });
}
