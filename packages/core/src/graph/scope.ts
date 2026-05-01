import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, sep, posix } from "node:path";
import { languageOf } from "./walker.js";

export type FailureScope =
  | { kind: "stack-trace"; text: string }
  | { kind: "failing-test"; path: string; testName?: string }
  | { kind: "symbol"; name: string; file?: string }
  | { kind: "file"; path: string };

export interface ScopeBudget {
  maxFiles?: number;
  maxLoc?: number;
  maxDepth?: number;
}

export interface ResolvedScope {
  files: string[];
  seeds: string[];
  estimatedLoc: number;
  primarySymbol: string | null;
  notes: string[];
}

const TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const PY_EXTS = [".py", ".pyi"];
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".turbo",
  "coverage", "__pycache__", ".venv", "venv", "env", ".tox",
]);
const BYTES_PER_LINE = 30;

const TS_IMPORT_RE = /(?:import\s+(?:[^'"`;]*?)\s+from\s*|import\s*|export\s+(?:\*|\{[^}]*\})\s+from\s*|require\s*\(\s*|import\s*\(\s*)["'`]([^"'`]+)["'`]/g;
const PY_IMPORT_FROM_RE = /^\s*from\s+(\.+\w*(?:\.\w+)*|\w+(?:\.\w+)*)\s+import\s+/gm;
const PY_IMPORT_RE = /^\s*import\s+(\w+(?:\.\w+)*)/gm;

const toPosix = (p: string): string => p.split(sep).join("/");
const isParseable = (rel: string): boolean => languageOf(rel) === "typescript" || languageOf(rel) === "python";
const safeRead = (abs: string): string | null => { try { return readFileSync(abs, "utf8"); } catch { return null; } };
const safeSize = (abs: string): number => { try { return statSync(abs).size; } catch { return 0; } };

interface PkgEntry { name: string; dir: string }

function scanRepo(repoRoot: string): {
  files: string[];
  packages: PkgEntry[];
  pyPackages: Map<string, string>;
} {
  const files: string[] = [];
  const packages: PkgEntry[] = [];
  // dirs that contain __init__.py — used to detect Python top-level packages.
  const dirsWithInit = new Set<string>();
  const visit = (absDir: string): void => {
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = join(absDir, ent.name);
      if (ent.isDirectory()) {
        if (!IGNORE_DIRS.has(ent.name)) visit(abs);
      } else if (ent.isFile()) {
        const rel = toPosix(relative(repoRoot, abs));
        if (isParseable(rel)) files.push(rel);
        if (ent.name === "__init__.py") {
          dirsWithInit.add(toPosix(relative(repoRoot, absDir)));
        }
        if (ent.name === "package.json") {
          const txt = safeRead(abs);
          if (!txt) continue;
          try {
            const j = JSON.parse(txt) as { name?: string };
            if (typeof j.name === "string" && j.name.length > 0) {
              packages.push({ name: j.name, dir: toPosix(relative(repoRoot, absDir)) });
            }
          } catch { /* skip */ }
        }
      }
    }
  };
  visit(repoRoot);
  // A "top-level" Python package is a dir with __init__.py whose parent dir
  // does NOT have __init__.py — that parent acts like a sys.path entry.
  const pyPackages = new Map<string, string>();
  for (const dir of dirsWithInit) {
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    if (!dirsWithInit.has(parent)) {
      const pkgName = dir.includes("/") ? dir.slice(dir.lastIndexOf("/") + 1) : dir;
      // Prefer the shortest path when two candidates share a name.
      const existing = pyPackages.get(pkgName);
      if (!existing || dir.length < existing.length) pyPackages.set(pkgName, dir);
    }
  }
  return { files, packages, pyPackages };
}

function tryFiles(repoRoot: string, candidates: string[]): string | null {
  for (const c of candidates) {
    const norm = toPosix(c);
    const abs = join(repoRoot, norm);
    if (existsSync(abs) && statSync(abs).isFile()) return norm;
  } return null;
}

function resolveRelative(repoRoot: string, fromFileRel: string, spec: string, isPython: boolean): string | null {
  const fromDir = toPosix(dirname(fromFileRel));
  const exts = isPython ? PY_EXTS : TS_EXTS;
  let target: string;
  if (isPython) {
    let dots = 0;
    while (dots < spec.length && spec[dots] === ".") dots++;
    let base = fromDir;
    for (let i = 1; i < dots; i++) base = posix.dirname(base);
    const rest = spec.slice(dots).replace(/\./g, "/");
    target = rest ? posix.join(base, rest) : base;
  } else {
    // NodeNext convention: source files import sibling .ts via ".js" specifiers.
    // Strip a trailing JS/TS extension before trying alternatives.
    const stripped = spec.replace(/\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/, "");
    target = posix.normalize(posix.join(fromDir, stripped));
  }
  const cands: string[] = [];
  for (const ext of exts) cands.push(target + ext);
  for (const ext of exts) cands.push(posix.join(target, isPython ? "__init__" : "index") + ext);
  return tryFiles(repoRoot, cands);
}

function resolvePackage(repoRoot: string, spec: string, packages: PkgEntry[]): string | null {
  const matches = packages
    .filter((p) => spec === p.name || spec.startsWith(p.name + "/"))
    .sort((a, b) => b.name.length - a.name.length);
  for (const pkg of matches) {
    const sub = spec === pkg.name ? "" : spec.slice(pkg.name.length + 1);
    const base = sub ? posix.join(pkg.dir, "src", sub) : posix.join(pkg.dir, "src");
    const tries: string[] = [];
    for (const ext of TS_EXTS) tries.push(base + ext);
    for (const ext of TS_EXTS) tries.push(posix.join(base, "index") + ext);
    const got = tryFiles(repoRoot, tries);
    if (got) return got;
  }
  return null;
}

function extractImports(content: string, isPython: boolean): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  if (isPython) {
    PY_IMPORT_FROM_RE.lastIndex = 0;
    while ((m = PY_IMPORT_FROM_RE.exec(content)) !== null) if (m[1]) out.push(m[1]);
    PY_IMPORT_RE.lastIndex = 0;
    while ((m = PY_IMPORT_RE.exec(content)) !== null) if (m[1]) out.push(m[1]);
  } else {
    TS_IMPORT_RE.lastIndex = 0;
    while ((m = TS_IMPORT_RE.exec(content)) !== null) if (m[1]) out.push(m[1]);
  }
  return out;
}

function resolveAbsolutePy(repoRoot: string, spec: string, pyPackages: Map<string, string>): string | null {
  // For `from core.config import X` the head is "core" and tail is "config".
  // If "core" is a known top-level package dir, resolve to <pkgDir>/<tail>.py
  // or <pkgDir>/<tail>/__init__.py.
  const dot = spec.indexOf(".");
  const head = dot < 0 ? spec : spec.slice(0, dot);
  const tail = dot < 0 ? "" : spec.slice(dot + 1);
  const pkgDir = pyPackages.get(head);
  if (!pkgDir) return null;
  const tailPath = tail ? tail.replace(/\./g, "/") : "";
  const cands: string[] = [];
  if (tailPath) {
    cands.push(`${pkgDir}/${tailPath}.py`);
    cands.push(`${pkgDir}/${tailPath}/__init__.py`);
  } else {
    cands.push(`${pkgDir}/__init__.py`);
  }
  return tryFiles(repoRoot, cands);
}

function resolveSpec(
  repoRoot: string, from: string, spec: string,
  packages: PkgEntry[], pyPackages: Map<string, string>,
): string | null {
  const isPy = languageOf(from) === "python";
  if (isPy) {
    if (spec.startsWith(".")) return resolveRelative(repoRoot, from, spec, true);
    return resolveAbsolutePy(repoRoot, spec, pyPackages);
  }
  if (spec.startsWith(".") || spec.startsWith("/")) return resolveRelative(repoRoot, from, spec, false);
  return resolvePackage(repoRoot, spec, packages);
}

function parseStack(text: string): { paths: string[]; symbols: string[] } {
  const paths: string[] = [];
  const symbols: string[] = [];
  const seen = new Set<string>();
  const nodeRe = /at\s+(?:([^\s()]+)\s+\()?([^\s():]+):(\d+)(?::(\d+))?\)?/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(text)) !== null) {
    const p = m[2];
    if (p && !seen.has(p)) {
      seen.add(p);
      paths.push(p);
      symbols.push(m[1] ?? "");
    }
  }
  const pyRe = /File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+(\S+)/g;
  while ((m = pyRe.exec(text)) !== null) {
    const p = m[1];
    if (p && !seen.has(p)) {
      seen.add(p);
      paths.push(p);
      symbols.push(m[3] ?? "");
    }
  }
  return { paths, symbols };
}

function toRepoRel(repoRoot: string, p: string): string | null {
  let c = p;
  if (c.startsWith("file://")) c = c.slice(7);
  if (existsSync(join(repoRoot, c)) && statSync(join(repoRoot, c)).isFile()) {
    return toPosix(relative(repoRoot, join(repoRoot, c)));
  }
  if (c.startsWith("/")) {
    const rel = relative(repoRoot, c);
    if (!rel.startsWith("..") && existsSync(c)) return toPosix(rel);
  }
  return toPosix(c).replace(/^\.\//, "");
}

function findSymbolFiles(repoRoot: string, allFiles: string[], name: string, scopeFile?: string): string[] {
  const safe = name.replace(/[^A-Za-z0-9_]/g, "");
  if (!safe) return [];
  const re = new RegExp(`\\b(?:function|class|def|interface|type|enum)\\s+${safe}\\b|\\b(?:const|let|var)\\s+${safe}\\b\\s*=`);
  const files = scopeFile ? [scopeFile] : allFiles;
  const out: string[] = [];
  for (const f of files) { const t = safeRead(join(repoRoot, f)); if (t && re.test(t)) out.push(f); }
  return out;
}

function findCallers(repoRoot: string, allFiles: string[], seedRel: string): string[] {
  const safe = posix.basename(seedRel.replace(/\.[^./]+$/, "")).replace(/[^A-Za-z0-9_]/g, "");
  if (!safe) return [];
  // Match the seed basename anywhere inside an import/require/from string,
  // not only flush against the closing quote — `from "./rca/runner.js"` must
  // match for seed=runner.ts. Allow non-quote characters before AND after.
  const re = new RegExp(
    `(?:from\\s+["'\`][^"'\`]*\\b${safe}\\b[^"'\`]*["'\`])` +
      `|(?:require\\(\\s*["'\`][^"'\`]*\\b${safe}\\b[^"'\`]*["'\`])` +
      `|(?:from\\s+[.\\w]*\\b${safe}\\b\\s+import)` +
      `|(?:import\\s+["'\`][^"'\`]*\\b${safe}\\b[^"'\`]*["'\`])`,
  );
  const out: string[] = [];
  for (const f of allFiles) {
    if (f === seedRel) continue;
    const t = safeRead(join(repoRoot, f));
    if (t && re.test(t)) out.push(f);
  }
  return out;
}

export function resolveScope(
  failure: FailureScope, repoRoot: string, budget: ScopeBudget = {},
): ResolvedScope {
  const maxFiles = budget.maxFiles ?? 200;
  const maxLoc = budget.maxLoc ?? 20000;
  const maxDepth = budget.maxDepth ?? 2;
  const notes: string[] = [];
  const { files: allFiles, packages, pyPackages } = scanRepo(repoRoot);
  const seeds: string[] = [];
  let primarySymbol: string | null = null;

  if (failure.kind === "file") {
    const norm = toPosix(failure.path);
    if (existsSync(join(repoRoot, norm))) seeds.push(norm);
    else notes.push(`seed file not found: ${norm}`);
  } else if (failure.kind === "failing-test") {
    const norm = toPosix(failure.path);
    if (existsSync(join(repoRoot, norm))) seeds.push(norm);
    else notes.push(`failing-test path not found: ${norm}`);
  } else if (failure.kind === "symbol") {
    primarySymbol = failure.name;
    const matches = findSymbolFiles(repoRoot, allFiles, failure.name, failure.file);
    if (matches.length === 0) notes.push(`no definition found for symbol ${failure.name}`);
    for (const m of matches) seeds.push(m);
  } else {
    const { paths, symbols } = parseStack(failure.text);
    let n = 0;
    for (let i = 0; i < paths.length && n < 5; i++) {
      const rel = toRepoRel(repoRoot, paths[i]!);
      if (!rel || !existsSync(join(repoRoot, rel)) || !isParseable(rel)) continue;
      if (!seeds.includes(rel)) {
        seeds.push(rel);
        if (primarySymbol === null) {
          const sym = symbols[i];
          if (sym && sym !== "<anonymous>") primarySymbol = sym;
        }
        n++;
      }
    }
    if (seeds.length === 0) notes.push("no in-repo frames found in stack trace");
  }

  const result = new Set<string>(seeds.filter(isParseable));
  let estimatedLoc = 0;
  for (const s of result) estimatedLoc += Math.max(1, Math.round(safeSize(join(repoRoot, s)) / BYTES_PER_LINE));
  let cap: string | null = null;
  if (estimatedLoc >= maxLoc) cap = `maxLoc=${maxLoc}`;
  if (result.size >= maxFiles) cap = cap ?? `maxFiles=${maxFiles}`;

  const addFile = (rel: string): boolean => {
    if (!isParseable(rel) || result.has(rel)) return false;
    if (result.size >= maxFiles) { cap = cap ?? `maxFiles=${maxFiles}`; return false; }
    const lines = Math.max(1, Math.round(safeSize(join(repoRoot, rel)) / BYTES_PER_LINE));
    if (estimatedLoc + lines > maxLoc) { cap = cap ?? `maxLoc=${maxLoc}`; return false; }
    result.add(rel);
    estimatedLoc += lines;
    return true;
  };

  let frontier: string[] = Array.from(result);
  for (let depth = 0; depth < maxDepth && cap === null; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      if (cap !== null) break;
      const txt = safeRead(join(repoRoot, f));
      if (!txt) continue;
      const isPy = languageOf(f) === "python";
      for (const spec of extractImports(txt, isPy)) {
        const r = resolveSpec(repoRoot, f, spec, packages, pyPackages);
        if (r && !result.has(r) && isParseable(r)) {
          if (addFile(r)) next.push(r);
          if (cap !== null) break;
        }
      }
    }
    frontier = next;
    if (next.length === 0) break;
  }

  if (cap === null) {
    for (const seed of seeds) {
      if (cap !== null) break;
      for (const c of findCallers(repoRoot, allFiles, seed)) {
        if (!result.has(c) && !addFile(c)) break;
      }
    }
  }

  if (cap !== null) notes.push(`scope capped by ${cap}`);
  return { files: Array.from(result).sort(), seeds, estimatedLoc, primarySymbol, notes };
}
