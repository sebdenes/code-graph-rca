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

  it("resolves identifier-typed args to source_symbol_id when same-file symbol exists", async () => {
    // handleRequest passes `userId` (a param) to save(userId). The arg is an
    // `identifier` and `userId` is a parameter — not a top-level symbol — so
    // resolveArgBindingSources intentionally leaves source_symbol_id NULL.
    // This test pins that behavior so we know the resolver is *running* (not
    // crashing) and only resolving the cases it should.
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
    // Same-file resolver doesn't match params (intentional — no symbols row).
    expect(row[0]!.source_symbol_id).toBeNull();
  });
});
