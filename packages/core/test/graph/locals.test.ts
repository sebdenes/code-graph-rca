import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexScope } from "../../src/graph/orchestrator.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "ts-locals");
const PY_FIXTURE = join(here, "..", "fixtures", "py-locals");

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
          ORDER BY s.start_line, s.name`,
      )
      .all() as LocalRow[];

    // bar, baz at depth 1; nested + destructured x,y now also captured.
    const names = rows.map((r) => r.name);
    expect(names).toContain("bar");
    expect(names).toContain("baz");
    for (const row of rows) {
      expect(row.kind).toBe("local");
      expect(row.parent_kind).toBe("function");
    }
  });

  it("DOES extract nested-block locals (depth > 1)", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const row = r.db
      .prepare(
        `SELECT s.name, p.name AS parent_name
           FROM symbols s LEFT JOIN symbols p ON p.id = s.parent_id
          WHERE s.kind='local' AND s.name='nested'`,
      )
      .get() as { name: string; parent_name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.parent_name).toBe("foo");
  });

  it("DOES extract destructured locals as separate rows", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const rows = r.db
      .prepare(
        `SELECT s.name FROM symbols s
           LEFT JOIN symbols p ON p.id = s.parent_id
          WHERE s.kind='local' AND p.name='foo'
            AND s.name IN ('x','y')`,
      )
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    expect(names.has("x")).toBe(true);
    expect(names.has("y")).toBe(true);
  });

  it("extracts loop iteration vars (for...of, for...in, C-style for)", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const rows = r.db
      .prepare(
        `SELECT s.name FROM symbols s
           LEFT JOIN symbols p ON p.id = s.parent_id
          WHERE s.kind='local' AND p.name='loops'`,
      )
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    expect(names.has("ofVar")).toBe(true);
    expect(names.has("inKey")).toBe(true);
    expect(names.has("cIdx")).toBe(true);
  });

  it("extracts array-destructured locals (with rest)", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const rows = r.db
      .prepare(
        `SELECT s.name FROM symbols s
           LEFT JOIN symbols p ON p.id = s.parent_id
          WHERE s.kind='local' AND p.name='arrayDestr'`,
      )
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    expect(names.has("first")).toBe(true);
    expect(names.has("second")).toBe(true);
    expect(names.has("rest")).toBe(true);
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

describe("kind='local' symbol extraction (Python)", () => {
  it("extracts top-level + nested-block + tuple-unpacked locals", async () => {
    const r = await indexScope({ repoRoot: PY_FIXTURE });
    const rows = r.db
      .prepare(
        `SELECT s.name FROM symbols s
           LEFT JOIN symbols p ON p.id = s.parent_id
          WHERE s.kind='local' AND p.name='foo'`,
      )
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    // depth-1
    expect(names.has("a")).toBe(true);
    expect(names.has("b")).toBe(true);
    // nested-block
    expect(names.has("nested")).toBe(true);
    // tuple_pattern unpack: c, e
    expect(names.has("c")).toBe(true);
    expect(names.has("e")).toBe(true);
    // parenthesized tuple_pattern: (g, h)
    expect(names.has("g")).toBe(true);
    expect(names.has("h")).toBe(true);
  });

  it("extracts `except E as exc` target with type_text=E", async () => {
    const r = await indexScope({ repoRoot: PY_FIXTURE });
    const row = r.db
      .prepare(
        `SELECT s.name, s.kind, s.type_text, p.name AS parent_name
           FROM symbols s
           LEFT JOIN symbols p ON p.id = s.parent_id
          WHERE s.kind='local' AND s.name='ioe' AND p.name='excepts'`,
      )
      .get() as
        | { name: string; kind: string; type_text: string | null; parent_name: string }
        | undefined;
    expect(row).toBeDefined();
    expect(row!.parent_name).toBe("excepts");
    expect(row!.type_text).toBe("IOError");
  });

  it("extracts `with open(...) as f` target (type_text NULL is OK)", async () => {
    const r = await indexScope({ repoRoot: PY_FIXTURE });
    const row = r.db
      .prepare(
        `SELECT s.name, s.kind, s.type_text, p.name AS parent_name
           FROM symbols s
           LEFT JOIN symbols p ON p.id = s.parent_id
          WHERE s.kind='local' AND s.name='f' AND p.name='withs'`,
      )
      .get() as
        | { name: string; kind: string; type_text: string | null; parent_name: string }
        | undefined;
    expect(row).toBeDefined();
    expect(row!.parent_name).toBe("withs");
    // type_text is NULL — `open()` return type is hard to infer; the local
    // is captured anyway so identifier-arg resolution can match `f`.
    expect(row!.type_text).toBeNull();
  });

  it("extracts for-loop iter vars (single + tuple unpack)", async () => {
    const r = await indexScope({ repoRoot: PY_FIXTURE });
    const rows = r.db
      .prepare(
        `SELECT s.name FROM symbols s
           LEFT JOIN symbols p ON p.id = s.parent_id
          WHERE s.kind='local' AND p.name='loops'`,
      )
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    expect(names.has("i")).toBe(true);    // for i in items
    expect(names.has("k")).toBe(true);    // for k, v in d.items()
    expect(names.has("v")).toBe(true);
    expect(names.has("j")).toBe(true);    // nested for j in range(k)
  });
});
