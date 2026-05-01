import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Db } from "../graph/db.js";
import { callersOf, definitionOf } from "../graph/queries.js";
import type {
  CallerNode,
  CallerTree,
  Definition,
  RecentChange,
} from "../types.js";

const TEST_PATH_REGEX = /(?:^|\/)(?:tests?|__tests__)\//i;
const TEST_FILE_REGEX = /(?:[._-]test|[._-]spec|test_)/i;

/** Heuristic: file looks like a test file by path or basename. */
function isTestPath(p: string): boolean {
  if (TEST_PATH_REGEX.test(p)) return true;
  const base = basename(p);
  return TEST_FILE_REGEX.test(base);
}

export interface ImpactNode {
  name: string;
  file: string;
  line: number;
  /** Hop distance from the changed symbol; 0 = the seed itself. */
  distance: number;
  /** 0..1 — heuristic risk of breaking this caller if the seed changes. */
  riskScore: number;
  /** Names of tests in the same file or subsystem that exercise this node, if any. */
  testCoverage: string[];
  /** Recent commit history attached to the node. */
  recentChanges: RecentChange[];
  /** Direct callers of this node (one hop deeper). */
  callers: ImpactNode[];
}

export interface ImpactResponse {
  seed: { name: string; file: string; line: number };
  /** Flat list of all affected nodes, sorted desc by riskScore. */
  nodes: ImpactNode[];
  /** Tree rooted at the seed, callers as children. */
  tree: ImpactNode;
  /** Summary risk: max riskScore across the tree. */
  maxRisk: number;
}

export interface ImpactRequest {
  symbolName: string;
  /** Optional file disambiguator when multiple symbols share a name. */
  file?: string;
  /** Walk depth for forward-impact callers. Default 3, max 5. */
  depth?: number;
  /** The repo root used to read test files; null disables test detection. */
  repoRoot: string | null;
  /** Open sqlite db handle for the indexed scope. */
  db: Db;
}

interface Sandbox {
  repoRoot: string | null;
  scopeFiles: string[];
}

function loadScope(db: Db): Sandbox & { repoRoot: string | null } {
  const rows = db
    .prepare("SELECT path FROM files ORDER BY path")
    .all() as Array<{ path: string }>;
  return {
    repoRoot: null,
    scopeFiles: rows.map((r) => r.path),
  };
}

/** Return number of unresolved outgoing CALLS from a (name, file) pair. */
function unresolvedOutgoingCount(
  db: Db,
  name: string,
  file: string | null,
): number {
  const sql = file
    ? `SELECT count(*) AS n
         FROM edges e
         JOIN symbols s ON s.id = e.from_symbol_id
         JOIN files f ON f.id = s.file_id
        WHERE s.name = ? AND f.path = ? AND e.kind = 'CALLS' AND e.to_symbol_id IS NULL`
    : `SELECT count(*) AS n
         FROM edges e
         JOIN symbols s ON s.id = e.from_symbol_id
        WHERE s.name = ? AND e.kind = 'CALLS' AND e.to_symbol_id IS NULL`;
  const params = file ? [name, file] : [name];
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Files in the indexed scope that look like tests AND mention the symbol. */
function findTestCoverage(
  scope: Sandbox,
  symbolName: string,
  callerFile: string,
): string[] {
  if (!scope.repoRoot) return [];
  const candidates = scope.scopeFiles.filter((p) => isTestPath(p));
  const callerDir = dirname(callerFile);
  candidates.sort((a, b) => {
    const aClose =
      dirname(a) === callerDir || dirname(a) === join(callerDir, "tests") ? 0 : 1;
    const bClose =
      dirname(b) === callerDir || dirname(b) === join(callerDir, "tests") ? 0 : 1;
    return aClose - bClose;
  });
  const matches: string[] = [];
  const needle = symbolName;
  for (const rel of candidates) {
    const abs = resolve(scope.repoRoot, rel);
    if (!existsSync(abs)) continue;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes(needle)) matches.push(basename(rel));
    if (matches.length >= 8) break;
  }
  return matches;
}

interface RiskInputs {
  unresolvedOut: number;
  recentCount: number;
  hasTest: boolean;
  distance: number;
  depth: number;
}

function computeRiskScore(inp: RiskInputs): number {
  let s = 0;
  if (inp.unresolvedOut >= 1) s += 0.4;
  s += Math.min(0.6, inp.recentCount * 0.3);
  if (!inp.hasTest) s += 0.2;
  const proximity = Math.max(0, inp.depth - inp.distance + 1) * 0.1;
  s += proximity;
  return Math.min(1, Math.max(0, s));
}

function recentChangesOf(node: CallerNode): RecentChange[] {
  return Array.isArray(node.recentChanges) ? node.recentChanges : [];
}

function within30Days(c: RecentChange): boolean {
  return typeof c.daysAgo === "number" && c.daysAgo <= 30;
}

function buildImpactTree(
  db: Db,
  scope: Sandbox,
  seedName: string,
  seedFile: string,
  seedLine: number,
  callerTree: CallerTree,
  depth: number,
  flat: ImpactNode[],
): ImpactNode {
  const seedNode: ImpactNode = {
    name: seedName,
    file: seedFile,
    line: seedLine,
    distance: 0,
    riskScore: 0,
    testCoverage: findTestCoverage(scope, seedName, seedFile),
    recentChanges: [],
    callers: [],
  };
  flat.push(seedNode);

  const seenAtDistance = new Map<string, number>();
  seenAtDistance.set(`${seedFile}:${seedName}`, 0);

  function recurse(callers: CallerNode[], distance: number): ImpactNode[] {
    const out: ImpactNode[] = [];
    for (const c of callers) {
      const key = `${c.file}:${c.name}`;
      const prior = seenAtDistance.get(key);
      if (prior !== undefined && prior <= distance) continue;
      seenAtDistance.set(key, distance);

      const rc = recentChangesOf(c);
      const recent30 = rc.filter(within30Days).length;
      const unresolvedOut = unresolvedOutgoingCount(db, c.name, c.file);
      const tests = findTestCoverage(scope, c.name, c.file);

      const node: ImpactNode = {
        name: c.name,
        file: c.file,
        line: c.line,
        distance,
        riskScore: computeRiskScore({
          unresolvedOut,
          recentCount: recent30,
          hasTest: tests.length > 0,
          distance,
          depth,
        }),
        testCoverage: tests,
        recentChanges: rc,
        callers: [],
      };
      flat.push(node);
      if (c.callers.length > 0) {
        node.callers = recurse(c.callers, distance + 1);
      }
      out.push(node);
    }
    return out;
  }

  seedNode.callers = recurse(callerTree.callers, 1);
  return seedNode;
}

/**
 * Pure impact analysis: given a symbol and an indexed graph, return the
 * forward-call (callers) tree rooted at the symbol with risk scoring.
 *
 * Throws if the symbol cannot be found in the graph.
 */
export function buildImpact(req: ImpactRequest): ImpactResponse {
  if (!req.symbolName || req.symbolName.length === 0) {
    throw new Error("symbolName required");
  }
  const requestedDepth = typeof req.depth === "number" ? req.depth : 3;
  const depth = Math.max(1, Math.min(5, Math.floor(requestedDepth)));

  const defs: Definition[] = definitionOf(req.db, req.symbolName);
  if (defs.length === 0) {
    throw new Error(`symbol not found: ${req.symbolName}`);
  }
  let chosen: Definition | undefined;
  if (req.file) {
    chosen = defs.find((d) => d.file === req.file);
  }
  if (!chosen) chosen = defs[0];
  if (!chosen) {
    throw new Error("symbol not found");
  }

  const callerOpts: {
    depth: number;
    hydrateRecency?: { repoRoot: string; sinceDays: number };
  } = { depth };
  if (req.repoRoot) {
    callerOpts.hydrateRecency = { repoRoot: req.repoRoot, sinceDays: 90 };
  }
  const callerTree = callersOf(req.db, req.symbolName, callerOpts);

  const baseScope = loadScope(req.db);
  const scope: Sandbox = {
    repoRoot: req.repoRoot,
    scopeFiles: baseScope.scopeFiles,
  };
  const flat: ImpactNode[] = [];
  const tree = buildImpactTree(
    req.db,
    scope,
    chosen.name,
    chosen.file,
    chosen.startLine,
    callerTree,
    depth,
    flat,
  );

  const sortedFlat = [...flat].sort((a, b) => b.riskScore - a.riskScore);
  const maxRisk = flat.reduce(
    (m, n) => (n.riskScore > m ? n.riskScore : m),
    0,
  );

  return {
    seed: { name: chosen.name, file: chosen.file, line: chosen.startLine },
    nodes: sortedFlat,
    tree,
    maxRisk,
  };
}
