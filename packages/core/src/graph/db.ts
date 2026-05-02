import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, "schema.sql");

/**
 * Schema version stamped into the `meta` table on first open and verified on
 * every subsequent open. Bump this whenever `schema.sql` changes shape so we
 * fail loudly instead of silently producing wrong results when a newer binary
 * meets an older persisted DB (or vice versa).
 *
 * - v1: initial shape shipped through v0.3.x (no `schema_version` row).
 * - v2: same shape; first version that stamps `schema_version` into meta.
 * - v3: edges gains `resolution_kind` column so unresolved CALLS edges can
 *   distinguish stdlib / external_module / instance_method / unknown
 *   instead of all collapsing onto confidence=0.5.
 * - v4: adds `params` (formal parameters per function/method symbol) and
 *   `arg_bindings` (per-call-site argument expressions classified as
 *   identifier/literal/member/call/spread/other). Foundation for data-flow
 *   queries like `pathBetween`. TypeScript only this round; Python deferred.
 * - v5: adds `blob_cache` table — (file_path, blob_sha) → ExtractedFile
 *   JSON. Lets cgrcad skip tree-sitter on files whose `git hash-object`
 *   already matches a cached row.
 * - v6: adds `symbols.type_text` column. Stores the raw type-annotation
 *   source text on `kind='param'` and `kind='local'` rows so
 *   resolve.ts can do light-touch receiver-type inference: an
 *   `obj.method(...)` call whose receiver `obj` is a local/param of a
 *   known class type now resolves to that class's method.
 */
export const SCHEMA_VERSION = 6;

export type Db = Database.Database;

export interface OpenOptions {
  /** filesystem path; omit for in-memory */
  persist?: string;
}

export function openDb(opts: OpenOptions = {}): Db {
  const path = opts.persist ?? ":memory:";
  const db = new Database(path);
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = OFF");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schema);

  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  if (row === undefined) {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
    ).run(String(SCHEMA_VERSION));
  } else {
    const persisted = Number(row.value);
    if (persisted !== SCHEMA_VERSION) {
      throw new Error(
        `Persisted DB at ${path} has schema v${persisted}, this binary expects v${SCHEMA_VERSION}. Re-index by deleting the file.`,
      );
    }
  }

  return db;
}
