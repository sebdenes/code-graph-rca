import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexScope } from "../../src/graph/orchestrator.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "ts-locals");

interface LocalRow {
  name: string;
  kind: string;
  parent_name: string | null;
  parent_kind: string | null;
  start_line: number;
  end_line: number;
}

describe("kind='local' symbol extraction (TypeScript)", () => {
  it("extracts top-level const/let inside foo as kind='local' with parent_id=foo", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const rows = r.db
      .prepare(
        `SELECT s.name, s.kind, p.name AS parent_name, p.kind AS parent_kind,
                s.start_line, s.end_line
           FROM symbols s
           LEFT JOIN symbols p ON p.id = s.parent_id
          WHERE s.kind = 'local'
            AND p.name = 'foo'
          ORDER BY s.start_line`,
      )
      .all() as LocalRow[];

    expect(rows.map((r) => r.name)).toEqual(["bar", "baz"]);
    for (const row of rows) {
      expect(row.kind).toBe("local");
      expect(row.parent_kind).toBe("function");
    }
  });

  it("does NOT extract nested-block locals (depth > 1)", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const nested = r.db
      .prepare("SELECT count(*) AS n FROM symbols WHERE kind='local' AND name='nested'")
      .get() as { n: number };
    expect(nested.n).toBe(0);
  });

  it("does NOT extract destructured locals (skipped per design)", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const xy = r.db
      .prepare("SELECT count(*) AS n FROM symbols WHERE kind='local' AND name IN ('x','y')")
      .get() as { n: number };
    expect(xy.n).toBe(0);
  });

  it("resolves identifier args to a kind='local' source symbol", async () => {
    // quux: const seed = compute(); return consume(seed);
    // The arg `seed` to consume() should resolve to the kind='local' row.
    const r = await indexScope({ repoRoot: FIXTURE });
    const row = r.db
      .prepare(
        `SELECT ab.source_text, ab.source_symbol_id
           FROM arg_bindings ab
           JOIN edges e ON e.id = ab.edge_id
           JOIN symbols s ON s.id = e.from_symbol_id
          WHERE s.name = 'quux' AND e.to_name = 'consume'`,
      )
      .all() as Array<{ source_text: string; source_symbol_id: number | null }>;
    expect(row).toHaveLength(1);
    expect(row[0]!.source_text).toBe("seed");
    expect(row[0]!.source_symbol_id).not.toBeNull();
    const sym = r.db
      .prepare("SELECT name, kind FROM symbols WHERE id = ?")
      .get(row[0]!.source_symbol_id) as { name: string; kind: string };
    expect(sym.name).toBe("seed");
    expect(sym.kind).toBe("local");
  });
});
