import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexScope } from "../../src/graph/orchestrator.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "py-receiver-types");

interface EdgeInfo {
  edge_id: number;
  to_name: string;
  to_kind: string | null;
  to_parent: string | null;
  resolution_kind: string | null;
}

function findCall(
  db: import("better-sqlite3").Database,
  callerName: string,
  toName: string,
): EdgeInfo[] {
  return db
    .prepare(
      `SELECT e.id AS edge_id, e.to_name AS to_name,
              ts.kind AS to_kind, tp.name AS to_parent,
              e.resolution_kind AS resolution_kind
         FROM edges e
         JOIN symbols fs ON fs.id = e.from_symbol_id
         LEFT JOIN symbols ts ON ts.id = e.to_symbol_id
         LEFT JOIN symbols tp ON tp.id = ts.parent_id
        WHERE fs.name = ?
          AND e.to_name = ?
          AND e.kind = 'CALLS'`,
    )
    .all(callerName, toName) as EdgeInfo[];
}

describe("Python receiver-type inference", () => {
  it("captures type_text on a typed parameter (kind='param' symbol)", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const row = r.db
      .prepare(
        `SELECT s.type_text
           FROM symbols s
           JOIN symbols p ON p.id = s.parent_id
          WHERE s.name = 'db'
            AND s.kind = 'param'
            AND p.name = 'run'`,
      )
      .get() as { type_text: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.type_text).toBe("Conn");
  });

  it("captures type_text on a typed local (kind='local' symbol)", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const row = r.db
      .prepare(
        `SELECT s.type_text
           FROM symbols s
           JOIN symbols p ON p.id = s.parent_id
          WHERE s.name = 'local'
            AND s.kind = 'local'
            AND p.name = 'run'`,
      )
      .get() as { type_text: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.type_text).toBe("Conn");
  });

  it("synthesises type_text='ServiceA' on the `self` param of a method", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const row = r.db
      .prepare(
        `SELECT s.type_text
           FROM symbols s
           JOIN symbols p ON p.id = s.parent_id
          WHERE s.name = 'self'
            AND s.kind = 'param'
            AND p.name = 'run'`,
      )
      .get() as { type_text: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.type_text).toBe("ServiceA");
  });

  it("resolves db.execute(...) on a Conn-typed param to Conn.execute", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const matches = findCall(r.db, "run", "execute");
    // run() calls db.execute(...) on line 1 and local.execute(...) on a later line — two edges.
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // At least one of them must point at a method named 'execute' parented by Conn.
    const resolved = matches.find(
      (m) => m.to_kind === "method" && m.to_parent === "Conn",
    );
    expect(resolved).toBeDefined();
    expect(resolved!.resolution_kind).toBeNull();
  });

  it("resolves db.commit() on a Conn-typed param to Conn.commit", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const matches = findCall(r.db, "run", "commit");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const resolved = matches.find(
      (m) => m.to_kind === "method" && m.to_parent === "Conn",
    );
    expect(resolved).toBeDefined();
    expect(resolved!.resolution_kind).toBeNull();
  });

  it("resolves local.execute(...) on a Conn-typed local to Conn.execute", async () => {
    // Distinguishes the local-receiver path from the param-receiver path.
    // We can't tell which edge is which by name alone — both use to_name='execute'.
    // Instead, count: with both `db.execute` and `local.execute` resolving to
    // the same Conn.execute symbol, there should be exactly 2 such edges from
    // run() pointing at Conn.execute.
    const r = await indexScope({ repoRoot: FIXTURE });
    const matches = findCall(r.db, "run", "execute");
    const toConnExecute = matches.filter(
      (m) => m.to_kind === "method" && m.to_parent === "Conn",
    );
    expect(toConnExecute).toHaveLength(2);
  });
});
