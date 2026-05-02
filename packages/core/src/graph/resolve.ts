import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { Db } from "./db.js";
import { isStdlibName } from "../rca/stdlib-names.js";

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

  // 0. Backfill parent_id for kind='local' rows. The extractor emits locals
  // with parentName set to the enclosing function's name, but the
  // insertExtracted symbol loop only resolves parent_id for class parents
  // (because `class:${parentName}` is the only key it tries). We patch those
  // locals here by range-matching: for each local, find the smallest-range
  // function/method/const symbol in the same file whose [start_line,end_line]
  // straddles the local's start_line, and set parent_id to that symbol.
  // resolveArgBindingSources below leans on this to scope a local to its
  // declaring function. Same shape as the param-as-symbol promotion in
  // insertExtracted: a synthetic kind row whose parent_id makes it findable
  // by name within a caller's scope.
  backfillLocalParents(db);

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

  // 5. Classify unresolved edges with resolution_kind so downstream stages
  // (LLM prompts, scoring, ambiguity counts) can treat stdlib / external pkg
  // / instance method / truly-missing differently. Without this, every
  // unresolved edge is indistinguishable at confidence=0.5.
  classifyUnresolved(db, repoRoot, filesById);

  // 6. Receiver-type inference (v6). For unresolved CALLS edges classified as
  // `instance_method`, look up the receiver symbol in the caller's scope; if
  // it's a kind='local'|'param' with a type_text matching a known class, and
  // the class has exactly one method with the call's to_name, resolve. Also
  // covers `self.method(...)` because parsePythonParameters synthesises
  // type_text=<enclosing-class> for `self`/`cls`. Reclassifies the edge as
  // resolved (resolution_kind = NULL) when a unique match is found.
  resolveReceiverTypes(db, repoRoot, filesById);

  // 7. Resolve `arg_bindings.source_symbol_id` for identifier-typed args.
  // Best-effort: looks for a same-file symbol (param of the caller, local
  // const/let, module-level export) whose name matches the arg's
  // source_text. Doesn't try cross-file unless an import binds the name.
  resolveArgBindingSources(db);
}

/**
 * Receiver-type inference, v6. Finds unresolved `obj.method(...)` calls
 * where:
 *   1. The call site source text contains `<receiver>.<to_name>(`.
 *   2. `<receiver>` is a kind='local' or kind='param' symbol scoped to the
 *      caller (parent_id == caller_id).
 *   3. That symbol's `type_text` resolves to a known kind='class' symbol.
 *      Type_text is matched as a bare identifier (`Conn`) — generic
 *      wrappers like `Optional[Conn]`, `Conn | None`, `List[Conn]` are
 *      stripped to the leading bare identifier first.
 *   4. The class has exactly one method named `to_name`. Multiple matches
 *      (overloads, inheritance) → leave unresolved; out of scope.
 *
 * Self-receiver fast path: when the receiver text is `self` or `cls` and
 * the caller is a method, the param-as-symbol row for `self` already has
 * type_text = enclosing class name (set by parsePythonParameters), so
 * Python `self.foo(...)` falls out of the same machinery as
 * `db.execute(...)`. No special-case branch in this function — it's all
 * one lookup table.
 */
function resolveReceiverTypes(
  db: Db,
  repoRoot: string,
  filesById: Map<number, FileRow>,
): void {
  const rows = db
    .prepare(
      `SELECT e.id AS edge_id, e.to_name AS to_name, e.call_line AS call_line,
              fs.id AS caller_id, fs.file_id AS file_id
         FROM edges e
         JOIN symbols fs ON fs.id = e.from_symbol_id
        WHERE e.to_symbol_id IS NULL
          AND e.kind = 'CALLS'
          AND e.resolution_kind = 'instance_method'`,
    )
    .all() as Array<{
      edge_id: number;
      to_name: string;
      call_line: number | null;
      caller_id: number;
      file_id: number;
    }>;
  if (rows.length === 0) return;

  // Source caching — same shape as classifyUnresolved.
  const sourceCache = new Map<number, string[] | null>();
  function getLine(fileId: number, lineNum: number | null): string | null {
    if (lineNum === null || lineNum <= 0) return null;
    let lines = sourceCache.get(fileId);
    if (lines === undefined) {
      const f = filesById.get(fileId);
      if (!f) {
        sourceCache.set(fileId, null);
        return null;
      }
      try {
        const text = readFileSync(join(repoRoot, f.path), "utf8");
        lines = text.split(/\r?\n/);
      } catch {
        lines = null;
      }
      sourceCache.set(fileId, lines);
    }
    if (!lines) return null;
    return lines[lineNum - 1] ?? null;
  }

  // Class lookup index: class_name → list of class symbols (across the repo).
  // We dedupe on (file_id, name) so two identically-named classes in
  // different files surface as ambiguous and are skipped (one match wins
  // only when there's exactly one class with that bare name in scope).
  const classRows = db
    .prepare(
      "SELECT id, file_id, name FROM symbols WHERE kind = 'class' OR kind = 'interface'",
    )
    .all() as Array<{ id: number; file_id: number; name: string }>;
  const classesByName = new Map<string, Array<{ id: number; file_id: number }>>();
  for (const c of classRows) {
    let bucket = classesByName.get(c.name);
    if (!bucket) {
      bucket = [];
      classesByName.set(c.name, bucket);
    }
    bucket.push({ id: c.id, file_id: c.file_id });
  }

  const findReceiverSym = db.prepare(
    `SELECT type_text FROM symbols
      WHERE parent_id = ? AND name = ? AND kind IN ('param', 'local')
        AND type_text IS NOT NULL
      LIMIT 1`,
  );
  const findMethodOnClass = db.prepare(
    "SELECT id FROM symbols WHERE parent_id = ? AND kind = 'method' AND name = ?",
  );
  const updateResolved = db.prepare(
    "UPDATE edges SET to_symbol_id = ?, confidence = 0.8, resolution_kind = NULL WHERE id = ?",
  );

  let resolved = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const line = getLine(r.file_id, r.call_line);
      if (line === null) continue;
      const receiver = parseReceiverFromCallLine(line, r.to_name);
      if (!receiver) continue;
      // Look up receiver in caller's scope.
      const recRow = findReceiverSym.get(r.caller_id, receiver) as
        | { type_text: string | null }
        | undefined;
      if (!recRow || !recRow.type_text) continue;
      const className = bareTypeIdent(recRow.type_text);
      if (!className) continue;
      const classes = classesByName.get(className);
      if (!classes || classes.length === 0) continue;
      // Look for the method on each candidate class. Across-class duplicates
      // (same method name on multiple identically-named classes in different
      // files) → skip; we only resolve when exactly one method matches.
      const matches: Array<{ id: number }> = [];
      for (const c of classes) {
        const ms = findMethodOnClass.all(c.id, r.to_name) as Array<{ id: number }>;
        for (const m of ms) matches.push(m);
      }
      if (matches.length !== 1) continue;
      updateResolved.run(matches[0]!.id, r.edge_id);
      resolved++;
    }
  });
  tx();
  // Resolved count is observable through the DB; no logging here so the
  // resolution pass stays silent (other passes don't log either).
  void resolved;
}

/**
 * Find the receiver text in a `<receiver>.<to_name>(` substring on a source
 * line. Returns null when no such pattern is found, or when the receiver is
 * a complex expression (chained attributes, subscripts, calls) that we
 * deliberately don't try to handle. Examples that resolve:
 *   `self.do_thing()` → "self"
 *   `db.execute(sql)` → "db"
 *   `cursor.fetchall()` → "cursor"
 * Examples that don't (returns null):
 *   `self._db.commit()`        — chained attribute (out of scope)
 *   `users[0].rename(...)`      — subscript receiver
 *   `make_db().execute(...)`    — call receiver
 *
 * Could later be extended to walk through chained `.attr.attr` if we tie
 * the leading attribute to a known class type, but the simple identifier
 * receiver alone covers most of the long tail in athlai (`db.execute`,
 * `cursor.fetchall`, `session.commit`).
 */
function parseReceiverFromCallLine(
  line: string,
  toName: string,
): string | null {
  // Locate the literal `.<toName>(` substring; if it appears multiple times
  // on the same line, we only handle the first to keep the heuristic
  // deterministic. Multi-call lines are rare in real code.
  const safe = toName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = line.match(new RegExp(`(\\b[A-Za-z_][A-Za-z0-9_]*)\\.${safe}\\s*\\(`));
  if (!match) return null;
  // match[1] is the immediately-preceding bare identifier. If the character
  // BEFORE that identifier is also a `.` or `]` or `)`, the receiver is
  // actually a chain — bail out and leave unresolved.
  const idStart = (match.index ?? 0);
  if (idStart > 0) {
    const prev = line[idStart - 1];
    if (prev === "." || prev === "]" || prev === ")") return null;
  }
  return match[1] ?? null;
}

/**
 * Strip generic wrappers and unions from a type annotation, returning the
 * leading bare class identifier. Examples:
 *   `Conn`                  → "Conn"
 *   `Optional[Conn]`        → "Conn"
 *   `Conn | None`           → "Conn"
 *   `list[Conn]`            → null (we don't unwrap collection types —
 *                                   the receiver is the list, not a Conn)
 *   `"Conn"` (forward ref)  → "Conn"
 *   `Tuple[int, str]`       → null (no single class)
 *
 * Conservative on purpose: receiver-type inference resolves only when we
 * can name *one* class with confidence. Anything fancier risks misresolving
 * to the wrong method.
 */
function bareTypeIdent(typeText: string): string | null {
  let s = typeText.trim();
  // Forward-ref string: "ClassName" → ClassName.
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  // Optional[T], Union[T, None] — strip the Optional wrapper.
  const optMatch = s.match(/^Optional\[(.+)\]$/);
  if (optMatch && optMatch[1]) s = optMatch[1].trim();
  // T | None / None | T — strip the None side. Multi-arm unions stay as-is
  // and fail the bare-ident check below.
  const pipeParts = s.split("|").map((p) => p.trim()).filter((p) => p && p !== "None");
  if (pipeParts.length === 1) s = pipeParts[0]!;
  // Plain bare ident? Accept.
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;
  return null;
}

/**
 * For each kind='local' symbol whose parent_id is NULL (insertExtracted only
 * sets parent_id for class parents), find the enclosing function/method/const
 * by range and patch parent_id. Smallest containing range wins so nested
 * arrow IIFEs prefer the inner function over the outer module function.
 */
function backfillLocalParents(db: Db): void {
  const locals = db
    .prepare(
      "SELECT id, file_id, start_line FROM symbols WHERE kind = 'local' AND parent_id IS NULL",
    )
    .all() as Array<{ id: number; file_id: number; start_line: number }>;
  if (locals.length === 0) return;
  // Bucket candidate parents by file once. Filter to function-shaped kinds —
  // we exclude classes/interfaces because a local belongs to the *function*
  // that declares it, not its enclosing class. Methods are included.
  const candidates = db
    .prepare(
      "SELECT id, file_id, start_line, end_line FROM symbols WHERE kind IN ('function', 'method', 'const')",
    )
    .all() as Array<{ id: number; file_id: number; start_line: number; end_line: number }>;
  const byFile = new Map<number, typeof candidates>();
  for (const c of candidates) {
    let bucket = byFile.get(c.file_id);
    if (!bucket) {
      bucket = [];
      byFile.set(c.file_id, bucket);
    }
    bucket.push(c);
  }
  const update = db.prepare("UPDATE symbols SET parent_id = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const loc of locals) {
      const bucket = byFile.get(loc.file_id);
      if (!bucket) continue;
      let best: { id: number; span: number } | null = null;
      for (const c of bucket) {
        if (c.start_line <= loc.start_line && loc.start_line <= c.end_line) {
          const span = c.end_line - c.start_line;
          if (best === null || span < best.span) {
            best = { id: c.id, span };
          }
        }
      }
      if (best) update.run(best.id, loc.id);
    }
  });
  tx();
}

/**
 * Best-effort second pass: for every `arg_bindings` row whose `source_kind`
 * is `identifier` (i.e. the arg is a bare name like `userId` rather than
 * `req.userId` or `42`), try to resolve `source_symbol_id` by looking up the
 * name in the caller's scope. We try, in order:
 *   1. A formal parameter of the *caller* function/method with the same name.
 *   2. A kind='local' symbol whose parent_id is the caller (a top-level
 *      const/let/var declared in the caller's body).
 *   3. Any same-file symbol with the matching name (covers module-level
 *      consts, top-level functions, locally-defined classes).
 *   4. An imported binding in the same file — pointing at the imported
 *      symbol on the *exporting* file.
 *
 * No cross-scope alias chasing, no shadowing analysis. The whole point is to
 * give `pathBetween` something to traverse, not to be a real type system.
 */
function resolveArgBindingSources(db: Db): void {
  // Pull all identifier-typed bindings together with their caller context.
  const rows = db
    .prepare(
      `SELECT ab.id AS id,
              ab.source_text AS source_text,
              fs.id AS caller_id,
              fs.file_id AS file_id
         FROM arg_bindings ab
         JOIN edges e ON e.id = ab.edge_id
         JOIN symbols fs ON fs.id = e.from_symbol_id
        WHERE ab.source_kind = 'identifier'
          AND ab.source_symbol_id IS NULL`,
    )
    .all() as Array<{
      id: number;
      source_text: string;
      caller_id: number;
      file_id: number;
    }>;
  if (rows.length === 0) return;

  // Caller's own parameter — promoted to a `kind='param'` row in `symbols`
  // (parent_id = caller's symbol id) by insertExtracted. The FK on
  // arg_bindings targets symbols, so source_symbol_id can point at this row
  // when an identifier arg matches a formal param of the caller. This is the
  // change that lifts identifier-arg resolution from ~1% (top-level same-file
  // only) to >40% (the dominant case: user code forwarding a param onward).
  const findCallerParamSymbol = db.prepare(
    "SELECT id FROM symbols WHERE parent_id = ? AND kind = 'param' AND name = ? LIMIT 1",
  );
  // Caller's own local — promoted to a `kind='local'` row in `symbols`
  // (parent_id = caller's symbol id) by the local-symbol pipeline. Looking
  // here picks up the dominant remaining identifier-arg pattern after params:
  // `const x = computeX(); save(x)` where `x` is a top-level local in the
  // caller. With params handling ~40% of identifier args, locals are the next
  // big slice (the unresolved 77% in week-4 measurements were predominantly
  // locals).
  const findCallerLocalSymbol = db.prepare(
    "SELECT id FROM symbols WHERE parent_id = ? AND kind = 'local' AND name = ? LIMIT 1",
  );
  // Same-file symbol, top-level only (parent_id IS NULL). Param symbols have
  // a non-null parent_id so this query naturally skips them.
  const findSameFileSym = db.prepare(
    "SELECT id FROM symbols WHERE file_id = ? AND name = ? AND parent_id IS NULL LIMIT 1",
  );
  // Imported-name → exporter symbol. We piggy-back on already-resolved CALLS
  // edges (see step 3 below) rather than re-walking the import graph here.
  const findImportedTargetViaEdge = db.prepare(
    `SELECT e.to_symbol_id AS sid
       FROM edges e
       JOIN symbols s ON s.id = e.from_symbol_id
      WHERE s.file_id = ?
        AND e.to_name = ?
        AND e.to_symbol_id IS NOT NULL
      LIMIT 1`,
  );

  const update = db.prepare(
    "UPDATE arg_bindings SET source_symbol_id = ? WHERE id = ?",
  );

  // Resolution priority: caller-param first (most identifier args in real
  // code are bare param forwards: `f(userId)` where userId is a param).
  // Top-level same-file second. Imports third. Earlier rounds had top-level
  // first because params couldn't live in `symbols` — that's no longer true.
  const tx = db.transaction(() => {
    for (const r of rows) {
      // 1) Caller's own param — promoted to a kind='param' symbol row.
      const callerParam = findCallerParamSymbol.get(
        r.caller_id,
        r.source_text,
      ) as { id: number } | undefined;
      if (callerParam) {
        update.run(callerParam.id, r.id);
        continue;
      }
      // 2) Caller's own local — promoted to a kind='local' symbol row.
      const callerLocal = findCallerLocalSymbol.get(
        r.caller_id,
        r.source_text,
      ) as { id: number } | undefined;
      if (callerLocal) {
        update.run(callerLocal.id, r.id);
        continue;
      }
      // 3) Same-file symbol (top-level).
      const sameFile = findSameFileSym.get(r.file_id, r.source_text) as
        | { id: number }
        | undefined;
      if (sameFile) {
        update.run(sameFile.id, r.id);
        continue;
      }
      // 4) Imports → resolve to symbol in the imported file. We piggy-back on
      // the import-resolution machinery already used by edges: an edge whose
      // to_name matches our identifier and whose from_symbol_id is in the
      // same file already had its target resolved — so we grab that
      // to_symbol_id directly. Avoids re-walking the import graph here.
      const viaEdge = findImportedTargetViaEdge.get(r.file_id, r.source_text) as
        | { sid: number | null }
        | undefined;
      if (viaEdge && viaEdge.sid) {
        update.run(viaEdge.sid, r.id);
      }
    }
  });
  tx();
}

function classifyUnresolved(
  db: Db,
  repoRoot: string,
  filesById: Map<number, FileRow>,
): void {
  // Pull every unresolved CALLS edge along with the file the call originates
  // from, so we can apply per-file imports + per-line source heuristics.
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.to_name AS to_name, e.call_line AS call_line,
              fs.file_id AS file_id
         FROM edges e
         JOIN symbols fs ON fs.id = e.from_symbol_id
        WHERE e.to_symbol_id IS NULL
          AND e.kind = 'CALLS'`,
    )
    .all() as Array<{
      id: number;
      to_name: string;
      call_line: number | null;
      file_id: number;
    }>;

  if (rows.length === 0) return;

  // file_id -> Map<local_name, source_module>
  const importsByFile = new Map<number, Map<string, string>>();
  const importRows = db
    .prepare("SELECT file_id, local_name, source_module FROM imports")
    .all() as Array<{ file_id: number; local_name: string; source_module: string }>;
  for (const r of importRows) {
    let m = importsByFile.get(r.file_id);
    if (!m) {
      m = new Map();
      importsByFile.set(r.file_id, m);
    }
    m.set(r.local_name, r.source_module);
  }

  // Cache file source by file_id; only loaded when needed for the
  // instance_method heuristic.
  const sourceCache = new Map<number, string[] | null>();
  function getLine(fileId: number, lineNum: number | null): string | null {
    if (lineNum === null || lineNum <= 0) return null;
    let lines = sourceCache.get(fileId);
    if (lines === undefined) {
      const f = filesById.get(fileId);
      if (!f) {
        sourceCache.set(fileId, null);
        return null;
      }
      try {
        const text = readFileSync(join(repoRoot, f.path), "utf8");
        lines = text.split(/\r?\n/);
      } catch {
        lines = null;
      }
      sourceCache.set(fileId, lines);
    }
    if (!lines) return null;
    return lines[lineNum - 1] ?? null;
  }

  const update = db.prepare(
    "UPDATE edges SET resolution_kind = ? WHERE id = ?",
  );

  const tx = db.transaction(() => {
    for (const r of rows) {
      const kind = classifyOne(
        r.to_name,
        r.file_id,
        r.call_line,
        importsByFile,
        getLine,
      );
      update.run(kind, r.id);
    }
  });
  tx();
}

/**
 * Classify a single unresolved CALLS edge. Order matters: stdlib first
 * (cheapest, highest precision), then external_module (import-table
 * lookup), then instance_method (source-line heuristic — approximate:
 * misses multi-line chained calls and may misfire on `obj.foo()` where
 * `foo` happens to also be a free function. Acceptable: classification
 * quality > NULL).
 */
function classifyOne(
  toName: string,
  fileId: number,
  callLine: number | null,
  importsByFile: Map<number, Map<string, string>>,
  getLine: (fileId: number, lineNum: number | null) => string | null,
): "stdlib" | "external_module" | "instance_method" | "unknown" {
  if (isStdlibName(toName)) return "stdlib";

  const imports = importsByFile.get(fileId);
  if (imports) {
    const sourceMod = imports.get(toName);
    if (sourceMod && !sourceMod.startsWith(".")) {
      return "external_module";
    }
  }

  // Heuristic: if the call-line text contains `.${to_name}(`, it's a method
  // call on some receiver expression. Approximate — cannot identify the
  // receiver type, just that this is dispatched off `.`.
  const line = getLine(fileId, callLine);
  if (line !== null) {
    // Escape regex metacharacters in to_name (identifiers shouldn't have
    // any, but be defensive).
    const safe = toName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\.${safe}\\s*\\(`).test(line)) {
      return "instance_method";
    }
  }

  return "unknown";
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
