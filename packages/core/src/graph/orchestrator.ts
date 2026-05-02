import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "./db.js";
import { walk, subsystemOf, type WalkOptions } from "./walker.js";
import { extractFile } from "./parser/extract.js";
import { resolveEdges } from "./resolve.js";
import type { ExtractedFile } from "../types.js";

export interface IndexOptions extends WalkOptions {
  repoRoot: string;
  /** Optional persistent DB path; defaults to in-memory. */
  persist?: string;
  /** Skip resolution pass (debugging aid). */
  skipResolve?: boolean;
}

export interface IndexResult {
  db: Db;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  importCount: number;
  unparsedCount: number;
}

export async function indexScope(opts: IndexOptions): Promise<IndexResult> {
  const db = openDb(opts.persist ? { persist: opts.persist } : {});
  // If persisting to an existing sqlite, clear the data tables before
  // re-indexing — otherwise the second run hits `UNIQUE constraint failed:
  // files.path`. We keep schema + meta; ON DELETE CASCADE on files takes
  // symbols + edges + imports with it, but we delete imports explicitly in
  // case a future schema relaxes the cascade.
  if (opts.persist) {
    // params + arg_bindings cascade with symbols/edges, so the existing CASCADE
    // chain handles them — but we delete explicitly to be defensive against
    // future schema relaxations and to surface ordering bugs early.
    db.exec(
      "DELETE FROM arg_bindings; DELETE FROM params; DELETE FROM imports; DELETE FROM edges; DELETE FROM symbols; DELETE FROM files;",
    );
  }
  // Stamp repo_root into meta so a moved sqlite is self-describing.
  try {
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
    ).run("repo_root", opts.repoRoot);
  } catch {
    // meta table may not exist on older DBs; ignore.
  }
  const files = walk(opts.repoRoot, opts);

  // Pass 1 — sequential extract. Workers come in slice 3.
  const extracted: ExtractedFile[] = [];
  for (const f of files) {
    if (f.language === "unparsed") {
      const source = safeRead(f.absPath);
      extracted.push({
        path: f.relPath,
        language: "unparsed",
        loc: source ? countLoc(source) : 0,
        symbols: [],
        edges: [],
        imports: [],
      });
      continue;
    }
    const source = safeRead(f.absPath);
    if (source === null) continue;
    const out = await extractFile({ relPath: f.relPath, source });
    if (out) extracted.push(out);
  }

  insertExtracted(db, opts.repoRoot, extracted);

  if (!opts.skipResolve) resolveEdges(db, opts.repoRoot);

  const fileCount = (db.prepare("SELECT count(*) AS n FROM files").get() as { n: number }).n;
  const symbolCount = (db.prepare("SELECT count(*) AS n FROM symbols").get() as { n: number }).n;
  const edgeCount = (db.prepare("SELECT count(*) AS n FROM edges").get() as { n: number }).n;
  const importCount = (db.prepare("SELECT count(*) AS n FROM imports").get() as { n: number }).n;
  const unparsedCount = (
    db.prepare("SELECT count(*) AS n FROM files WHERE language = 'unparsed'").get() as { n: number }
  ).n;

  return { db, fileCount, symbolCount, edgeCount, importCount, unparsedCount };
}

function insertExtracted(db: Db, repoRoot: string, files: ExtractedFile[]): void {
  const insertFile = db.prepare(
    "INSERT INTO files (path, language, subsystem, loc) VALUES (?, ?, ?, ?)",
  );
  const insertSymbol = db.prepare(
    "INSERT INTO symbols (file_id, name, kind, parent_id, start_line, end_line, signature, exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertEdge = db.prepare(
    "INSERT INTO edges (from_symbol_id, to_symbol_id, to_name, kind, confidence, call_line) VALUES (?, NULL, ?, ?, ?, ?)",
  );
  const insertImport = db.prepare(
    "INSERT INTO imports (file_id, local_name, source_module, source_name, kind) VALUES (?, ?, ?, ?, ?)",
  );
  const insertParam = db.prepare(
    "INSERT INTO params (symbol_id, position, name, type_text, has_default) VALUES (?, ?, ?, ?, ?)",
  );
  const insertArgBinding = db.prepare(
    "INSERT INTO arg_bindings (edge_id, position, source_kind, source_text, source_symbol_id) VALUES (?, ?, ?, ?, NULL)",
  );

  const tx = db.transaction((items: ExtractedFile[]) => {
    for (const f of items) {
      const subsystem = subsystemOf(repoRoot, f.path);
      const fileRes = insertFile.run(f.path, f.language, subsystem, f.loc);
      const fileId = fileRes.lastInsertRowid as number;

      // Insert classes first so methods can reference parent_id.
      const symbolIdsByKey = new Map<string, number>();
      const classes = f.symbols.filter((s) => s.kind === "class" || s.kind === "interface");
      for (const s of classes) {
        const res = insertSymbol.run(
          fileId,
          s.name,
          s.kind,
          null,
          s.startLine,
          s.endLine,
          s.signature,
          s.exported ? 1 : 0,
        );
        symbolIdsByKey.set(`${s.kind}:${s.name}`, res.lastInsertRowid as number);
      }
      for (const s of f.symbols) {
        if (s.kind === "class" || s.kind === "interface") continue;
        let parentId: number | null = null;
        if (s.parentName) {
          parentId = symbolIdsByKey.get(`class:${s.parentName}`) ?? null;
        }
        const res = insertSymbol.run(
          fileId,
          s.name,
          s.kind,
          parentId,
          s.startLine,
          s.endLine,
          s.signature,
          s.exported ? 1 : 0,
        );
        symbolIdsByKey.set(
          s.parentName ? `${s.kind}:${s.parentName}.${s.name}` : `${s.kind}:${s.name}`,
          res.lastInsertRowid as number,
        );
      }

      for (const e of f.edges) {
        const fromKey = e.fromParentName
          ? `method:${e.fromParentName}.${e.fromName}`
          : findFromKey(symbolIdsByKey, e.fromName);
        const fromId = fromKey ? symbolIdsByKey.get(fromKey) : undefined;
        if (!fromId) continue;
        const edgeRes = insertEdge.run(fromId, e.toName, e.kind, e.confidence, e.callLine);
        const edgeId = edgeRes.lastInsertRowid as number;
        if (e.argBindings && e.argBindings.length > 0) {
          for (const ab of e.argBindings) {
            insertArgBinding.run(edgeId, ab.position, ab.sourceKind, ab.sourceText);
          }
        }
      }

      for (const imp of f.imports) {
        insertImport.run(fileId, imp.localName, imp.sourceModule, imp.sourceName, imp.kind);
      }

      // Params: attach to the corresponding symbol id via the same
      // (kind, parentName, name) key the edge loop uses. Only TS extracts
      // these; for Python `symbolParams` is undefined and this loop is a
      // no-op.
      if (f.symbolParams) {
        for (const sp of f.symbolParams) {
          const key = sp.ownerParentName
            ? `${sp.ownerKind}:${sp.ownerParentName}.${sp.ownerName}`
            : `${sp.ownerKind}:${sp.ownerName}`;
          const symbolId = symbolIdsByKey.get(key);
          if (!symbolId) continue;
          for (const p of sp.params) {
            insertParam.run(
              symbolId,
              p.position,
              p.name,
              p.typeText,
              p.hasDefault ? 1 : 0,
            );
          }
        }
      }
    }
  });
  tx(files);

  // suppress unused-import warning
  void repoRoot;
}

function findFromKey(map: Map<string, number>, name: string): string | null {
  const order: Array<"function" | "method" | "const" | "class"> = ["function", "method", "const", "class"];
  for (const k of order) {
    if (map.has(`${k}:${name}`)) return `${k}:${name}`;
  }
  return null;
}

function safeRead(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function countLoc(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

void join;
