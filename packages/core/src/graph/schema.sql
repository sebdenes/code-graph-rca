PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  language TEXT NOT NULL,
  subsystem TEXT NOT NULL,
  loc INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  signature TEXT,
  exported INTEGER NOT NULL DEFAULT 0,
  -- v6: raw type-annotation text on `kind='param'` and `kind='local'` rows.
  -- Captured for Python (`x: SomeClass = ...`, `def f(x: SomeClass)`) and
  -- TypeScript (parameter `: SomeType`). Powers receiver-type inference in
  -- resolve.ts: when an unresolved `obj.method(...)` call has a receiver
  -- whose type_text matches a known class symbol, the call resolves to that
  -- class's method. NULL when unknown / not annotated.
  type_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_export_lookup ON symbols(file_id, name, exported);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  to_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  call_line INTEGER,
  -- NULL for resolved edges. For unresolved CALLS edges, classifies *why*
  -- we couldn't resolve: 'stdlib' | 'external_module' | 'instance_method' | 'unknown'.
  -- Lets the LLM and scorer treat "we know this is `len`" differently from
  -- "no idea what this is".
  resolution_kind TEXT
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_to_name ON edges(to_name);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  local_name TEXT NOT NULL,
  source_module TEXT NOT NULL,
  source_name TEXT NOT NULL,
  kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_lookup ON imports(file_id, local_name);

-- Each formal parameter of each function/method symbol.
-- Populated for TypeScript only in v4; Python deferred.
CREATE TABLE IF NOT EXISTS params (
  id INTEGER PRIMARY KEY,
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,        -- 0-based
  name TEXT NOT NULL,
  type_text TEXT,                   -- raw type annotation if available, else NULL
  has_default INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_params_symbol ON params(symbol_id);

-- Each argument expression at each call site.
-- Populated for TypeScript only in v4; Python deferred.
CREATE TABLE IF NOT EXISTS arg_bindings (
  id INTEGER PRIMARY KEY,
  edge_id INTEGER NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,        -- 0-based
  source_kind TEXT NOT NULL,        -- 'identifier' | 'literal' | 'member' | 'call' | 'spread' | 'other'
  source_text TEXT NOT NULL,        -- the raw text of the arg expression
  source_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL  -- resolved when source is a known identifier/symbol
);
CREATE INDEX IF NOT EXISTS idx_arg_bindings_edge ON arg_bindings(edge_id);
CREATE INDEX IF NOT EXISTS idx_arg_bindings_source ON arg_bindings(source_symbol_id);

-- v5: cgrcad blob-sha cache. Skips tree-sitter on files whose
-- `git hash-object` already matches a cached row. Keyed by file_path
-- (one row per path; we overwrite on sha change).
CREATE TABLE IF NOT EXISTS blob_cache (
  file_path TEXT PRIMARY KEY,
  blob_sha TEXT NOT NULL,
  extracted_json TEXT NOT NULL,
  cached_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blob_cache_sha ON blob_cache(blob_sha);
