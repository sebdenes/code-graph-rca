import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { Db } from "./db.js";

interface FileRow {
  id: number;
  path: string;
  language: string;
}

interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  parent_id: number | null;
}

interface EdgeRow {
  id: number;
  from_symbol_id: number;
  to_name: string;
  kind: string;
  confidence: number;
}

interface ImportRow {
  id: number;
  file_id: number;
  local_name: string;
  source_module: string;
  source_name: string;
  kind: string;
}

const TS_TRY_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const TS_TRY_INDEX = TS_TRY_EXT.map((e) => `/index${e}`);

export function resolveEdges(db: Db, repoRoot: string): void {
  const files = db.prepare("SELECT id, path, language FROM files").all() as FileRow[];
  const filesById = new Map<number, FileRow>(files.map((f) => [f.id, f]));
  const fileIdByPath = new Map<string, number>(files.map((f) => [f.path, f.id]));

  const workspacePackages = scanWorkspacePackages(repoRoot);
  const pyPackageRoots = scanPyPackageRoots(repoRoot);

  // 1. Same-file unique-name resolution.
  const sameFile = db.prepare(`
    UPDATE edges
       SET to_symbol_id = (
         SELECT s.id FROM symbols s
          WHERE s.file_id = (SELECT file_id FROM symbols WHERE id = edges.from_symbol_id)
            AND s.name = edges.to_name
          LIMIT 1
       )
     WHERE to_symbol_id IS NULL
       AND (
         SELECT count(*) FROM symbols s
          WHERE s.file_id = (SELECT file_id FROM symbols WHERE id = edges.from_symbol_id)
            AND s.name = edges.to_name
       ) = 1
  `);
  sameFile.run();

  // 2. Self/this method resolution within enclosing class.
  resolveSelfMethods(db);

  // 3. Cross-file via imports.
  resolveViaImports(db, filesById, fileIdByPath, workspacePackages, pyPackageRoots, repoRoot);

  // 4. Mark anything still unresolved with confidence 0.5 (was 1.0 default for calls).
  db.prepare(
    "UPDATE edges SET confidence = 0.5 WHERE to_symbol_id IS NULL AND kind = 'CALLS' AND confidence > 0.5",
  ).run();
}

function resolveSelfMethods(db: Db): void {
  // For each unresolved CALLS edge whose to_name we suspect is a method call on
  // self/this: look for a method with that name in the from_symbol's parent class.
  // We don't have the receiver name in the edges table — but we encoded "method"
  // calls as edges where the to_name matches a method name AND the from_symbol's
  // parent_id points to a class in the same file. That's the conservative slice.
  //
  // Single match in the parent class → confidence 1.0.
  // Multiple matches across parent + descendants visible in scope → 0.7.
  const stmt = db.prepare(`
    SELECT e.id AS edge_id, e.to_name AS to_name,
           fs.parent_id AS parent_class_id, fs.file_id AS file_id
      FROM edges e
      JOIN symbols fs ON fs.id = e.from_symbol_id
     WHERE e.to_symbol_id IS NULL
       AND e.kind = 'CALLS'
       AND fs.kind = 'method'
       AND fs.parent_id IS NOT NULL
  `);
  const rows = stmt.all() as Array<{
    edge_id: number;
    to_name: string;
    parent_class_id: number;
    file_id: number;
  }>;
  const findMethods = db.prepare(
    "SELECT id FROM symbols WHERE kind = 'method' AND parent_id = ? AND name = ?",
  );
  const updateExact = db.prepare("UPDATE edges SET to_symbol_id = ?, confidence = 1.0 WHERE id = ?");
  const findInClassByName = db.prepare(
    "SELECT s.id FROM symbols s WHERE s.kind = 'method' AND s.name = ?",
  );
  const updateAmbiguous = db.prepare("UPDATE edges SET to_symbol_id = ?, confidence = 0.7 WHERE id = ?");
  for (const r of rows) {
    const inParent = findMethods.all(r.parent_class_id, r.to_name) as Array<{ id: number }>;
    if (inParent.length === 1) {
      updateExact.run(inParent[0]!.id, r.edge_id);
      continue;
    }
    if (inParent.length === 0) {
      // Maybe a method elsewhere — record as ambiguous if exactly one method by name exists project-wide.
      const all = findInClassByName.all(r.to_name) as Array<{ id: number }>;
      if (all.length === 1) updateAmbiguous.run(all[0]!.id, r.edge_id);
      continue;
    }
    // Multiple methods in same class with same name shouldn't happen, but be safe.
    updateAmbiguous.run(inParent[0]!.id, r.edge_id);
  }
}

function resolveViaImports(
  db: Db,
  filesById: Map<number, FileRow>,
  fileIdByPath: Map<string, number>,
  workspacePackages: Map<string, string>,
  pyPackageRoots: Map<string, string>,
  repoRoot: string,
): void {
  const allImports = db
    .prepare("SELECT id, file_id, local_name, source_module, source_name, kind FROM imports")
    .all() as ImportRow[];
  const importsByFileAndLocal = new Map<string, ImportRow>();
  for (const imp of allImports) {
    importsByFileAndLocal.set(`${imp.file_id}:${imp.local_name}`, imp);
  }

  const unresolved = db
    .prepare(
      `SELECT e.id AS id, e.from_symbol_id AS from_symbol_id, e.to_name AS to_name, e.kind AS kind, fs.file_id AS file_id
         FROM edges e
         JOIN symbols fs ON fs.id = e.from_symbol_id
        WHERE e.to_symbol_id IS NULL`,
    )
    .all() as Array<{
      id: number;
      from_symbol_id: number;
      to_name: string;
      kind: string;
      file_id: number;
    }>;

  const updateExact = db.prepare("UPDATE edges SET to_symbol_id = ?, confidence = 1.0 WHERE id = ?");
  // No `exported` filter: Python doesn't mark exports, and a named import is
  // an explicit assertion that the symbol is reachable. We trust the import.
  const findInFile = db.prepare(
    "SELECT id FROM symbols WHERE file_id = ? AND name = ? AND parent_id IS NULL",
  );

  for (const e of unresolved) {
    const imp = importsByFileAndLocal.get(`${e.file_id}:${e.to_name}`);
    if (!imp) continue;

    const fromFile = filesById.get(e.file_id);
    if (!fromFile) continue;
    const targetFileId = resolveImportTargetFileId(
      imp,
      fromFile,
      filesById,
      fileIdByPath,
      workspacePackages,
      pyPackageRoots,
      repoRoot,
    );
    if (!targetFileId) continue;

    // The actual symbol name in the target is imp.source_name (or to_name when same).
    const targetName = imp.source_name && imp.source_name !== "*" ? imp.source_name : e.to_name;
    const matches = findInFile.all(targetFileId, targetName) as Array<{ id: number }>;
    if (matches.length === 1) updateExact.run(matches[0]!.id, e.id);
  }

  // Also handle the case where the call is `mod.something()` and `mod` is a
  // namespace import. We don't track receivers in edges yet; the .scm captures
  // them but the extractor encoded them only for self/this. Leave for future.
}

function resolveImportTargetFileId(
  imp: ImportRow,
  fromFile: FileRow,
  filesById: Map<number, FileRow>,
  fileIdByPath: Map<string, number>,
  workspacePackages: Map<string, string>,
  pyPackageRoots: Map<string, string>,
  repoRoot: string,
): number | null {
  const sourceMod = imp.source_module;

  if (fromFile.language === "typescript") {
    if (sourceMod.startsWith(".")) {
      // Relative import — resolve against fromFile path.
      const baseDir = posix.dirname(fromFile.path);
      const stripped = sourceMod.replace(/\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/, "");
      const candidate = posix.normalize(posix.join(baseDir, stripped));
      const found = tryTsResolve(candidate, fileIdByPath);
      if (found !== null) return found;
      return null;
    }
    // Workspace package import e.g. "@fixture/auth".
    const pkgRoot = workspacePackages.get(sourceMod);
    if (pkgRoot) {
      // Try common entry points.
      const tries = [`${pkgRoot}/src/index`, `${pkgRoot}/index`];
      for (const t of tries) {
        const found = tryTsResolve(t, fileIdByPath);
        if (found !== null) return found;
      }
      // If imported name re-exports from another file, we can't follow re-exports
      // in v1 (per §9 stub). Return the index file anyway so downstream lookup
      // still has a chance via same-name symbol search.
      return null;
    }
    return null;
  }

  if (fromFile.language === "python") {
    if (sourceMod.startsWith(".")) {
      // relative_import like ".transform" or "..pkg.sub"
      const dots = sourceMod.match(/^\.+/)?.[0] ?? ".";
      const tail = sourceMod.slice(dots.length);
      const fromDir = posix.dirname(fromFile.path);
      const upLevels = dots.length - 1;
      let dir = fromDir;
      for (let i = 0; i < upLevels; i++) dir = posix.dirname(dir);
      const tailPath = tail ? tail.replace(/\./g, "/") : "";
      const candidateA = tailPath ? posix.join(dir, tailPath + ".py") : null;
      const candidateB = tailPath
        ? posix.join(dir, tailPath, "__init__.py")
        : posix.join(dir, "__init__.py");
      if (candidateA && fileIdByPath.has(candidateA)) return fileIdByPath.get(candidateA)!;
      if (fileIdByPath.has(candidateB)) return fileIdByPath.get(candidateB)!;
      return null;
    }
    // Absolute python module path: resolve via known package roots.
    for (const [pkgName, pkgDir] of pyPackageRoots) {
      if (sourceMod === pkgName || sourceMod.startsWith(pkgName + ".")) {
        const tail = sourceMod === pkgName ? "" : sourceMod.slice(pkgName.length + 1);
        const tailPath = tail.replace(/\./g, "/");
        const a = tailPath ? posix.join(pkgDir, tailPath + ".py") : posix.join(pkgDir, "__init__.py");
        const b = tailPath ? posix.join(pkgDir, tailPath, "__init__.py") : null;
        if (fileIdByPath.has(a)) return fileIdByPath.get(a)!;
        if (b && fileIdByPath.has(b)) return fileIdByPath.get(b)!;
        return null;
      }
    }
    return null;
  }

  void filesById;
  void repoRoot;
  return null;
}

function tryTsResolve(candidate: string, fileIdByPath: Map<string, number>): number | null {
  for (const ext of TS_TRY_EXT) {
    const p = candidate + ext;
    if (fileIdByPath.has(p)) return fileIdByPath.get(p)!;
  }
  for (const idx of TS_TRY_INDEX) {
    const p = candidate + idx;
    if (fileIdByPath.has(p)) return fileIdByPath.get(p)!;
  }
  return null;
}

function scanWorkspacePackages(repoRoot: string): Map<string, string> {
  const result = new Map<string, string>();
  // Walk up to 4 levels deep looking for package.json with "name".
  function visit(absDir: string, relDir: string, depth: number): void {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
      const abs = join(absDir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) visit(abs, rel, depth + 1);
      else if (ent.isFile() && ent.name === "package.json") {
        try {
          const j = JSON.parse(readFileSync(abs, "utf8")) as { name?: string };
          if (typeof j.name === "string" && j.name.length > 0) {
            result.set(j.name, relDir || ".");
          }
        } catch {
          // ignore
        }
      }
    }
  }
  visit(repoRoot, "", 0);
  return result;
}

function scanPyPackageRoots(repoRoot: string): Map<string, string> {
  // Find directories that contain __init__.py — their dir name is the import
  // root, mapped to repo-relative path.
  const result = new Map<string, string>();
  function visit(absDir: string, relDir: string, depth: number): void {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    let hasInit = false;
    for (const ent of entries) {
      if (ent.name === "__init__.py" && ent.isFile()) hasInit = true;
    }
    if (hasInit && relDir) {
      const segs = relDir.split("/");
      const pkgName = segs[segs.length - 1]!;
      // Only set if not nested under another package — i.e. parent has no __init__.py.
      const parentInit = join(dirname(absDir), "__init__.py");
      if (!existsSync(parentInit)) {
        result.set(pkgName, relDir);
      }
    }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
      if (!ent.isDirectory()) continue;
      const abs = join(absDir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      try {
        const st = statSync(abs);
        if (st.isDirectory()) visit(abs, rel, depth + 1);
      } catch {
        // ignore
      }
    }
  }
  visit(repoRoot, "", 0);
  return result;
}
