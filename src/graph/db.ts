import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, "schema.sql");

export type Db = Database.Database;

export interface OpenOptions {
  /** filesystem path; omit for in-memory */
  persist?: string;
}

export function openDb(opts: OpenOptions = {}): Db {
  const db = new Database(opts.persist ?? ":memory:");
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = OFF");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schema);
  return db;
}
