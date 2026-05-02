import { readFileSync, readdirSync, realpathSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import type { Ignore } from "ignore";
import type { Language } from "../types.js";

const requireFromHere = createRequire(import.meta.url);
const ignore = requireFromHere("ignore") as (options?: { ignorecase?: boolean }) => Ignore;

const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const PY_EXT = new Set([".py", ".pyi"]);

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".tox",
]);

export interface DiscoveredFile {
  absPath: string;
  relPath: string;
  language: Language;
}

export interface WalkOptions {
  /** Limit walk to these repo-relative paths (files or dirs). When set, only files within these paths are returned. */
  scope?: string[];
  /** Limit total files returned. */
  maxFiles?: number;
}

export function languageOf(path: string): Language {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "unparsed";
  const ext = path.slice(dot).toLowerCase();
  if (TS_EXT.has(ext)) return "typescript";
  if (PY_EXT.has(ext)) return "python";
  return "unparsed";
}

function loadGitignore(repoRoot: string): Ignore {
  const ig = ignore();
  const gi = join(repoRoot, ".gitignore");
  if (existsSync(gi)) {
    try {
      ig.add(readFileSync(gi, "utf8"));
    } catch {
      // best-effort
    }
  }
  return ig;
}

export function walk(repoRoot: string, opts: WalkOptions = {}): DiscoveredFile[] {
  const ig = loadGitignore(repoRoot);
  const out: DiscoveredFile[] = [];
  const seen = new Set<string>();
  // Track resolved real paths of directories already visited to break symlink loops
  // (e.g. `ln -s . loop` inside the indexed scope would otherwise recurse forever).
  const seenDirs = new Set<string>();
  const max = opts.maxFiles ?? Infinity;

  const scope = opts.scope?.map((p) => p.split(sep).join("/"));

  function inScope(rel: string): boolean {
    if (!scope || scope.length === 0) return true;
    const norm = rel.split(sep).join("/");
    return scope.some((s) => norm === s || norm.startsWith(s + "/"));
  }

  function visit(absDir: string): void {
    if (out.length >= max) return;
    let real: string;
    try {
      real = realpathSync(absDir);
    } catch {
      return;
    }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort lexicographically so traversal order is stable across filesystems
    // (macOS APFS / ext4 don't otherwise guarantee any particular order).
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (out.length >= max) return;
      const abs = join(absDir, ent.name);
      const rel = relative(repoRoot, abs);
      if (rel.startsWith("..") || rel === "") continue;

      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        const relForIgnore = rel + "/";
        if (ig.ignores(relForIgnore)) continue;
        visit(abs);
        continue;
      }
      // A symlink may point at a directory; if so, recurse (with the seenDirs
      // guard preventing loops). Otherwise treat as a file.
      if (ent.isSymbolicLink()) {
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (IGNORE_DIRS.has(ent.name)) continue;
          const relForIgnore = rel + "/";
          if (ig.ignores(relForIgnore)) continue;
          visit(abs);
          continue;
        }
        if (!st.isFile()) continue;
      } else if (!ent.isFile()) {
        continue;
      }

      if (ig.ignores(rel)) continue;
      if (!inScope(rel)) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ absPath: abs, relPath: rel.split(sep).join("/"), language: languageOf(rel) });
    }
  }

  if (scope && scope.length > 0) {
    for (const s of scope) {
      const abs = join(repoRoot, s);
      if (!existsSync(abs)) continue;
      const st = statSync(abs);
      if (st.isFile()) {
        const rel = s;
        if (!seen.has(abs)) {
          seen.add(abs);
          out.push({ absPath: abs, relPath: rel.split(sep).join("/"), language: languageOf(rel) });
        }
      } else if (st.isDirectory()) {
        visit(abs);
      }
    }
  } else {
    visit(repoRoot);
  }

  return out;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

/**
 * Subsystem derivation. For monorepos, prefers the workspace package name
 * detected by walking up to the nearest package.json with a "name" field
 * (or pyproject.toml [project].name). Falls back to the top-level dir.
 */
export function subsystemOf(repoRoot: string, relPath: string): string {
  const parts = relPath.split("/");
  if (parts.length <= 1) return "root";

  for (let i = parts.length - 1; i >= 1; i--) {
    const dir = parts.slice(0, i).join("/");
    const pkgJson = join(repoRoot, dir, "package.json");
    if (existsSync(pkgJson)) {
      try {
        const j = JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: string };
        if (typeof j.name === "string" && j.name.length > 0) return j.name;
      } catch {
        // fall through
      }
    }
    const pyproj = join(repoRoot, dir, "pyproject.toml");
    if (existsSync(pyproj)) {
      try {
        const txt = readFileSync(pyproj, "utf8");
        const m = txt.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
        if (m) return m[1]!;
      } catch {
        // fall through
      }
    }
  }

  return parts[0] ?? "root";
}
