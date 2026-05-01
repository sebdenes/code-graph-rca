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
  exported INTEGER NOT NULL DEFAULT 0
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
