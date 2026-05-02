import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Db } from "../graph/db.js";
import { extractFile } from "../graph/parser/extract.js";
import { resolveEdges } from "../graph/resolve.js";
import { subsystemOf, languageOf } from "../graph/walker.js";
import type { ExtractedFile } from "../types.js";

/**
 * Single-file extract + insert helpers used by the fs-watcher invalidator.
 *
 * Mirrors the per-file half of `graph/orchestrator.ts#insertExtracted` but
 * scoped to one path: delete the existing `files` row (ON DELETE CASCADE
 * sweeps symbols/edges/imports/params/arg_bindings) and re-insert from a
 * fresh `extractFile` result. `resolveEdges` is called after the insert so
 * cross-file resolution catches up — it's whole-DB but idempotent and cheap
 * relative to a full re-index.
 */

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

/** Drop all rows for `relPath`. CASCADE sweeps the dependent tables. */
export function removeFile(db: Db, relPath: string): void {
  const norm = relPath.split(sep).join("/");
  db.prepare("DELETE FROM files WHERE path = ?").run(norm);
  db.prepare("DELETE FROM blob_cache WHERE file_path = ?").run(norm);
}

/**
 * Re-extract a single file and replace its rows in the DB. Returns true on
 * success, false if the file couldn't be read or extracted (caller should
 * still consider the path "handled" — likely deleted between events).
 */
export async function reExtractFile(
  db: Db,
  repoRoot: string,
  relPath: string,
): Promise<boolean> {
  const norm = relPath.split(sep).join("/");
  const absPath = join(repoRoot, norm);
  const lang = languageOf(norm);

  let extracted: ExtractedFile | null;
  if (lang === "unparsed") {
    const source = safeRead(absPath);
    if (source === null) return false;
    extracted = {
      path: norm,
      language: "unparsed",
      loc: countLoc(source),
      symbols: [],
      edges: [],
      imports: [],
    };
  } else {
    const source = safeRead(absPath);
    if (source === null) return false;
    extracted = await extractFile({ relPath: norm, source });
    if (!extracted) return false;
  }

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM files WHERE path = ?").run(norm);

    const subsystem = subsystemOf(repoRoot, norm);
    const fileRes = db
      .prepare(
        "INSERT INTO files (path, language, subsystem, loc) VALUES (?, ?, ?, ?)",
      )
      .run(norm, extracted!.language, subsystem, extracted!.loc);
    const fileId = fileRes.lastInsertRowid as number;

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

    const symbolIdsByKey = new Map<string, number>();
    const classes = extracted!.symbols.filter(
      (s) => s.kind === "class" || s.kind === "interface",
    );
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
    for (const s of extracted!.symbols) {
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
        s.parentName
          ? `${s.kind}:${s.parentName}.${s.name}`
          : `${s.kind}:${s.name}`,
        res.lastInsertRowid as number,
      );
    }

    for (const e of extracted!.edges) {
      const fromKey = e.fromParentName
        ? `method:${e.fromParentName}.${e.fromName}`
        : findFromKey(symbolIdsByKey, e.fromName);
      const fromId = fromKey ? symbolIdsByKey.get(fromKey) : undefined;
      if (!fromId) continue;
      const edgeRes = insertEdge.run(
        fromId,
        e.toName,
        e.kind,
        e.confidence,
        e.callLine,
      );
      const edgeId = edgeRes.lastInsertRowid as number;
      if (e.argBindings && e.argBindings.length > 0) {
        for (const ab of e.argBindings) {
          insertArgBinding.run(edgeId, ab.position, ab.sourceKind, ab.sourceText);
        }
      }
    }

    for (const imp of extracted!.imports) {
      insertImport.run(
        fileId,
        imp.localName,
        imp.sourceModule,
        imp.sourceName,
        imp.kind,
      );
    }

    if (extracted!.symbolParams) {
      for (const sp of extracted!.symbolParams) {
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
  });
  tx();

  // Re-resolve cross-file edges. resolveEdges is whole-DB but idempotent —
  // for a single-file change it's still O(edges) which dominates the
  // insert anyway.
  resolveEdges(db, repoRoot);
  return true;
}

function findFromKey(
  map: Map<string, number>,
  name: string,
): string | null {
  const order: Array<"function" | "method" | "const" | "class"> = [
    "function",
    "method",
    "const",
    "class",
  ];
  for (const k of order) {
    if (map.has(`${k}:${name}`)) return `${k}:${name}`;
  }
  return null;
}

void relative;
