import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION } from "../../src/graph/db.js";

function tmpDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cgrca-db-test-"));
  const path = join(dir, "graph.sqlite");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("openDb schema versioning", () => {
  it("stamps SCHEMA_VERSION on a fresh in-memory DB", () => {
    const db = openDb();
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe(String(SCHEMA_VERSION));
  });

  it("stamps SCHEMA_VERSION on a fresh persist file", () => {
    const { path, cleanup } = tmpDbPath();
    try {
      const db = openDb({ persist: path });
      const row = db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      expect(row?.value).toBe(String(SCHEMA_VERSION));
      db.close();
    } finally {
      cleanup();
    }
  });

  it("re-opens cleanly when version already matches", () => {
    const { path, cleanup } = tmpDbPath();
    try {
      openDb({ persist: path }).close();
      // Second open must not throw and must keep the same row.
      const db = openDb({ persist: path });
      const row = db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      expect(row?.value).toBe(String(SCHEMA_VERSION));
      db.close();
    } finally {
      cleanup();
    }
  });

  it("throws a diagnostic error when persisted version != current", () => {
    const { path, cleanup } = tmpDbPath();
    try {
      // Seed a file that has the schema but the wrong version stamp.
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
      );
      seed
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '99')")
        .run();
      seed.close();

      expect(() => openDb({ persist: path })).toThrowError(
        new RegExp(
          `Persisted DB at .* has schema v99, this binary expects v${SCHEMA_VERSION}\\. Re-index by deleting the file\\.`,
        ),
      );
    } finally {
      cleanup();
    }
  });

  it("asserts current SCHEMA_VERSION is 5", () => {
    expect(SCHEMA_VERSION).toBe(5);
  });

  it("rejects a v4 persisted DB so re-index is forced", () => {
    const { path, cleanup } = tmpDbPath();
    try {
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
      );
      seed
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4')")
        .run();
      seed.close();

      expect(() => openDb({ persist: path })).toThrowError(
        /has schema v4, this binary expects v5\. Re-index by deleting the file\./,
      );
    } finally {
      cleanup();
    }
  });

  it("backfills schema_version on a legacy file with meta but no row", () => {
    const { path, cleanup } = tmpDbPath();
    try {
      // Pre-create the meta table with no schema_version row (legacy v1 DB).
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
      );
      seed
        .prepare("INSERT INTO meta (key, value) VALUES ('repo_root', '/x')")
        .run();
      seed.close();

      const db = openDb({ persist: path });
      const row = db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      expect(row?.value).toBe(String(SCHEMA_VERSION));
      // repo_root preserved.
      const repo = db
        .prepare("SELECT value FROM meta WHERE key = 'repo_root'")
        .get() as { value: string } | undefined;
      expect(repo?.value).toBe("/x");
      db.close();
    } finally {
      cleanup();
    }
  });
});
