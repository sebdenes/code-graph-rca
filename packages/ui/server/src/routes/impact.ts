import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  callersOf,
  definitionOf,
  type CallerNode,
  type CallerTree,
  type Definition,
  type RecentChange,
} from "code-graph-rca";
import type {
  ImpactNode,
  ImpactRequest,
  ImpactResponse,
} from "../../../shared/api.js";
import type { SessionRecord } from "../sessions.js";

const TEST_PATH_REGEX = /(?:^|\/)(?:tests?|__tests__)\//i;
const TEST_FILE_REGEX = /(?:[._-]test|[._-]spec|test_)/i;

/** Heuristic: file looks like a test file by path or basename. */
function isTestPath(p: string): boolean {
  if (TEST_PATH_REGEX.test(p)) return true;
  const base = basename(p);
  return TEST_FILE_REGEX.test(base);
}

interface Sandbox {
  repoRoot: string | null;
  /** All file paths known to the indexed scope, relative to repoRoot. */
  scopeFiles: string[];
}

function loadScope(rec: SessionRecord): Sandbox {
  const rows = rec.db
    .prepare("SELECT path FROM files ORDER BY path")
    .all() as Array<{ path: string }>;
  return {
    repoRoot: rec.repoRoot,
    scopeFiles: rows.map((r) => r.path),
  };
}

/** Return number of unresolved outgoing CALLS from a (name, file) pair. */
function unresolvedOutgoingCount(
  rec: SessionRecord,
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
  const row = rec.db.prepare(sql).get(...params) as { n: number };
  return row?.n ?? 0;
}

/** Files in the indexed scope that look like tests AND mention the symbol. */
function findTestCoverage(
  rec: SessionRecord,
  scope: Sandbox,
  symbolName: string,
  callerFile: string,
): string[] {
  if (!scope.repoRoot) return [];
  const candidates = scope.scopeFiles.filter((p) => isTestPath(p));
  // Prefer same-dir / sibling tests dir matches first.
  const callerDir = dirname(callerFile);
  candidates.sort((a, b) => {
    const aClose = dirname(a) === callerDir || dirname(a) === join(callerDir, "tests") ? 0 : 1;
    const bClose = dirname(b) === callerDir || dirname(b) === join(callerDir, "tests") ? 0 : 1;
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
  /** Total walk depth used to size the proximity bonus. */
  depth: number;
}

function computeRiskScore(inp: RiskInputs): number {
  let s = 0;
  if (inp.unresolvedOut >= 1) s += 0.4;
  s += Math.min(0.6, inp.recentCount * 0.3);
  if (!inp.hasTest) s += 0.2;
  // Proximity: depth=1 -> +0.3, depth=2 -> +0.2, depth=3 -> +0.1.
  // i.e. +0.1 per hop closer.
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
  rec: SessionRecord,
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
    testCoverage: findTestCoverage(rec, scope, seedName, seedFile),
    recentChanges: [],
    callers: [],
  };
  flat.push(seedNode);

  const seenAtDistance = new Map<string, number>(); // key=file:name -> distance
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
      const unresolvedOut = unresolvedOutgoingCount(rec, c.name, c.file);
      const tests = findTestCoverage(rec, scope, c.name, c.file);

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

export function registerImpactRoute(
  fastify: FastifyInstance,
  sessions: Map<string, SessionRecord>,
): void {
  fastify.post<{ Params: { id: string }; Body: ImpactRequest }>(
    "/api/session/:id/impact",
    async (req, reply): Promise<ImpactResponse | undefined> => {
      const rec = sessions.get(req.params.id);
      if (!rec) {
        reply.code(404).send({ error: "session not found" });
        return undefined;
      }
      const body = req.body;
      if (!body || typeof body.symbolName !== "string" || body.symbolName.length === 0) {
        reply.code(400).send({ error: "symbolName required" });
        return undefined;
      }
      const requestedDepth = typeof body.depth === "number" ? body.depth : 3;
      const depth = Math.max(1, Math.min(5, Math.floor(requestedDepth)));

      const defs: Definition[] = definitionOf(rec.db, body.symbolName);
      let chosen: Definition | undefined;
      if (defs.length === 0) {
        reply.code(404).send({ error: `symbol not found: ${body.symbolName}` });
        return undefined;
      }
      if (body.file) {
        chosen = defs.find((d) => d.file === body.file);
      }
      if (!chosen) chosen = defs[0];
      if (!chosen) {
        reply.code(404).send({ error: "symbol not found" });
        return undefined;
      }

      const callerOpts: {
        depth: number;
        hydrateRecency?: { repoRoot: string; sinceDays: number };
      } = { depth };
      if (rec.repoRoot) {
        callerOpts.hydrateRecency = { repoRoot: rec.repoRoot, sinceDays: 90 };
      }
      const callerTree = callersOf(rec.db, body.symbolName, callerOpts);

      const scope = loadScope(rec);
      const flat: ImpactNode[] = [];
      const tree = buildImpactTree(
        rec,
        scope,
        chosen.name,
        chosen.file,
        chosen.startLine,
        callerTree,
        depth,
        flat,
      );

      const sortedFlat = [...flat].sort((a, b) => b.riskScore - a.riskScore);
      const maxRisk = flat.reduce((m, n) => (n.riskScore > m ? n.riskScore : m), 0);

      return {
        seed: { name: chosen.name, file: chosen.file, line: chosen.startLine },
        nodes: sortedFlat,
        tree,
        maxRisk,
      };
    },
  );
}
