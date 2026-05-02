import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexScope } from "../../src/graph/orchestrator.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "ts-dataflow");

interface ArgRow {
  position: number;
  source_kind: string;
  source_text: string;
}

describe("arg_bindings extraction (TypeScript)", () => {
  it("classifies bar(user.id, \"literal\", computeX()) as member/literal/call", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });

    const rows = r.db
      .prepare(
        `SELECT ab.position, ab.source_kind, ab.source_text
           FROM arg_bindings ab
           JOIN edges e ON e.id = ab.edge_id
           JOIN symbols s ON s.id = e.from_symbol_id
          WHERE s.name = 'bar'
            AND e.to_name = 'target'
          ORDER BY ab.position`,
      )
      .all() as ArgRow[];

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      position: 0,
      source_kind: "member",
      source_text: "user.id",
    });
    expect(rows[1]).toMatchObject({
      position: 1,
      source_kind: "literal",
    });
    expect(rows[1]!.source_text).toBe('"literal"');
    expect(rows[2]).toMatchObject({
      position: 2,
      source_kind: "call",
      source_text: "computeX()",
    });
  });

  it("resolves identifier-typed args to the caller's param-as-symbol row", async () => {
    // handleRequest passes `userId` (its formal param) to save(userId). The
    // arg is an `identifier`. With param-as-symbol promotion (insertExtracted
    // materialises a kind='param' symbol per param), identifier args
    // matching a caller's formal param now resolve to that synthetic row.
    // Before promotion this returned NULL; kept here as a regression on the
    // intentional behavior change that lifts identifier-arg resolution from
    // ~1% to >40% on the cgrca self-index.
    const r = await indexScope({ repoRoot: FIXTURE });
    const row = r.db
      .prepare(
        `SELECT ab.source_kind, ab.source_text, ab.source_symbol_id
           FROM arg_bindings ab
           JOIN edges e ON e.id = ab.edge_id
           JOIN symbols s ON s.id = e.from_symbol_id
          WHERE s.name = 'handleRequest' AND e.to_name = 'save'`,
      )
      .all() as Array<{
        source_kind: string;
        source_text: string;
        source_symbol_id: number | null;
      }>;
    expect(row).toHaveLength(1);
    expect(row[0]!.source_kind).toBe("identifier");
    expect(row[0]!.source_text).toBe("userId");
    const sid = row[0]!.source_symbol_id;
    expect(sid).not.toBeNull();
    const sym = r.db
      .prepare(
        `SELECT s.name, s.kind, p.name AS parent_name
           FROM symbols s
           LEFT JOIN symbols p ON p.id = s.parent_id
          WHERE s.id = ?`,
      )
      .get(sid) as { name: string; kind: string; parent_name: string | null };
    expect(sym.name).toBe("userId");
    expect(sym.kind).toBe("param");
    expect(sym.parent_name).toBe("handleRequest");
  });

  it("resolves self.helper() inside a Python class method to the right method symbol", async () => {
    // py-receiver-types fixture: ServiceA.run() calls self.helper(); helper
    // is a method on ServiceA. parsePythonParameters synthesises
    // type_text='ServiceA' for `self`, so resolveReceiverTypes resolves the
    // call to ServiceA.helper without needing the resolveSelfMethods fallback.
    const PY_RT = join(here, "..", "fixtures", "py-receiver-types");
    const r = await indexScope({ repoRoot: PY_RT });
    const row = r.db
      .prepare(
        `SELECT ts.id AS to_id, ts.kind AS to_kind, tp.name AS to_parent,
                e.resolution_kind AS resolution_kind
           FROM edges e
           JOIN symbols fs ON fs.id = e.from_symbol_id
           LEFT JOIN symbols ts ON ts.id = e.to_symbol_id
           LEFT JOIN symbols tp ON tp.id = ts.parent_id
          WHERE fs.name = 'run'
            AND e.to_name = 'helper'
            AND e.kind = 'CALLS'`,
      )
      .get() as
        | {
            to_id: number | null;
            to_kind: string | null;
            to_parent: string | null;
            resolution_kind: string | null;
          }
        | undefined;
    expect(row).toBeDefined();
    expect(row!.to_id).not.toBeNull();
    expect(row!.to_kind).toBe("method");
    expect(row!.to_parent).toBe("ServiceA");
    expect(row!.resolution_kind).toBeNull();
  });

  it("resolves an identifier arg to a kind='local' source symbol in the caller", async () => {
    // localCarrier: const payload = "hello"; return relay(payload);
    // `payload` is a top-level local in localCarrier's body; the arg binding
    // for relay(payload) should resolve to that kind='local' symbol row,
    // confirming the locals-as-symbols round trip end-to-end.
    const r = await indexScope({ repoRoot: FIXTURE });
    const row = r.db
      .prepare(
        `SELECT ab.source_kind, ab.source_text, ab.source_symbol_id
           FROM arg_bindings ab
           JOIN edges e ON e.id = ab.edge_id
           JOIN symbols s ON s.id = e.from_symbol_id
          WHERE s.name = 'localCarrier' AND e.to_name = 'relay'`,
      )
      .all() as Array<{
        source_kind: string;
        source_text: string;
        source_symbol_id: number | null;
      }>;
    expect(row).toHaveLength(1);
    expect(row[0]!.source_kind).toBe("identifier");
    expect(row[0]!.source_text).toBe("payload");
    expect(row[0]!.source_symbol_id).not.toBeNull();
    const sym = r.db
      .prepare(
        `SELECT s.name, s.kind, p.name AS parent_name
           FROM symbols s
           LEFT JOIN symbols p ON p.id = s.parent_id
          WHERE s.id = ?`,
      )
      .get(row[0]!.source_symbol_id) as {
        name: string;
        kind: string;
        parent_name: string | null;
      };
    expect(sym.name).toBe("payload");
    expect(sym.kind).toBe("local");
    expect(sym.parent_name).toBe("localCarrier");
  });
});
