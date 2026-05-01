import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { SessionSummary, RcaSnapshot } from "../../shared/api.js";

export interface SessionRecord {
  summary: SessionSummary;
  /** lazily opened, read-only sqlite handle */
  db: Database.Database;
  /** repoRoot recovered from meta table or the indexed file paths */
  repoRoot: string | null;
  /** parsed sidecar RcaResult (if a `*.rca.json` was found) */
  snapshot: RcaSnapshot | null;
}

export interface DiscoverOptions {
  /** Optional override path: a single .sqlite file or a directory. */
  path?: string;
  /** Cap on number of sqlite files discovered. */
  max?: number;
}

const DEFAULT_MAX = 200;

/**
 * Walk a directory (depth-first, capped) collecting `.sqlite` files. We do not
 * follow symlinks. Hidden directories are skipped.
 */
function walkSqlite(dir: string, max: number, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= max) return;
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walkSqlite(full, max, out);
    } else if (e.isFile() && extname(e.name) === ".sqlite") {
      out.push(full);
    }
  }
}

function readMeta(db: Database.Database, key: string): string | null {
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function inferRepoRoot(db: Database.Database): string | null {
  // First try meta. Then try to derive a common parent from indexed files,
  // but since the schema stores relative paths, that's not reliable.
  // We rely on the meta row.
  const fromMeta = readMeta(db, "repo_root");
  if (fromMeta && existsSync(fromMeta)) return fromMeta;
  return fromMeta;
}

function summarizeDb(
  db: Database.Database,
): { fileCount: number; symbolCount: number; edgeCount: number } {
  const fileCount =
    (db.prepare("SELECT count(*) AS n FROM files").get() as { n: number }).n;
  const symbolCount =
    (db.prepare("SELECT count(*) AS n FROM symbols").get() as { n: number }).n;
  const edgeCount =
    (db.prepare("SELECT count(*) AS n FROM edges").get() as { n: number }).n;
  return { fileCount, symbolCount, edgeCount };
}

function loadSnapshot(sqlitePath: string): RcaSnapshot | null {
  const sidecar = `${sqlitePath}.rca.json`;
  if (!existsSync(sidecar)) return null;
  try {
    const raw = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    // Map RcaResult -> RcaSnapshot. Forgiving on unknown shapes.
    const snap: RcaSnapshot = {
      primarySymbol:
        typeof raw.primarySymbol === "string"
          ? raw.primarySymbol
          : raw.primarySymbol === null
            ? null
            : null,
      scope: (raw.scope as RcaSnapshot["scope"]) ?? {
        files: [],
        symbolCount: 0,
        edgeCount: 0,
      },
      causalCandidates: Array.isArray(raw.causalCandidates)
        ? (raw.causalCandidates as RcaSnapshot["causalCandidates"])
        : [],
      firstHypothesis:
        typeof raw.firstHypothesis === "string" ? raw.firstHypothesis : null,
      graphContext:
        typeof raw.graphContext === "string" ? raw.graphContext : "",
      prompt: typeof raw.prompt === "string" ? raw.prompt : "",
      notes: Array.isArray(raw.notes) ? (raw.notes as string[]) : [],
    };
    return snap;
  } catch {
    return null;
  }
}

export function loadSession(sqlitePath: string): SessionRecord | null {
  const abs = resolve(sqlitePath);
  if (!existsSync(abs)) return null;
  let db: Database.Database;
  try {
    db = new Database(abs, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  const id = basename(abs, extname(abs));
  const stat = statSync(abs);
  const counts = summarizeDb(db);
  const snapshot = loadSnapshot(abs);
  const repoRoot = inferRepoRoot(db);
  const primarySymbol = readMeta(db, "primary_symbol") || snapshot?.primarySymbol || null;
  const summary: SessionSummary = {
    id,
    path: abs,
    repoRoot: repoRoot ?? null,
    createdAt: stat.mtime.toISOString(),
    fileCount: counts.fileCount,
    symbolCount: counts.symbolCount,
    edgeCount: counts.edgeCount,
    primarySymbol: primarySymbol && primarySymbol.length > 0 ? primarySymbol : null,
    rcaAvailable: snapshot !== null,
  };
  return { summary, db, repoRoot: repoRoot ?? null, snapshot };
}

export function discoverSessions(
  opts: DiscoverOptions = {},
): SessionRecord[] {
  const max = opts.max ?? DEFAULT_MAX;
  const candidates: string[] = [];
  if (opts.path) {
    const target = isAbsolute(opts.path) ? opts.path : resolve(opts.path);
    if (!existsSync(target)) return [];
    const st = statSync(target);
    if (st.isFile()) {
      candidates.push(target);
    } else if (st.isDirectory()) {
      walkSqlite(target, max, candidates);
    }
  } else {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (home) {
      const stash = join(home, ".cgrca", "sessions");
      if (existsSync(stash)) walkSqlite(stash, max, candidates);
    }
    walkSqlite(process.cwd(), max, candidates);
  }
  const records: SessionRecord[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const rec = loadSession(c);
    if (rec) records.push(rec);
  }
  return records;
}

/** Wrap a list of records into a name -> record map keyed by session id. */
export function indexById(records: SessionRecord[]): Map<string, SessionRecord> {
  const m = new Map<string, SessionRecord>();
  for (const r of records) m.set(r.summary.id, r);
  return m;
}
