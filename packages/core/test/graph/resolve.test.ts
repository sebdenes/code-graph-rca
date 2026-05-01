import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexScope } from "../../src/graph/orchestrator.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "py-resolution");

interface EdgeRow {
  to_name: string;
  resolution_kind: string | null;
}

describe("resolve.ts: resolution_kind classification", () => {
  it("classifies stdlib / external_module / instance_method / unknown", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });

    const rows = r.db
      .prepare(
        `SELECT e.to_name AS to_name, e.resolution_kind AS resolution_kind
           FROM edges e
           JOIN symbols s ON s.id = e.from_symbol_id
          WHERE s.name = 'driver'
            AND e.kind = 'CALLS'
            AND e.to_symbol_id IS NULL`,
      )
      .all() as EdgeRow[];

    const byName = new Map<string, string | null>();
    for (const row of rows) byName.set(row.to_name, row.resolution_kind);

    // `len(x)` — Python builtin
    expect(byName.get("len")).toBe("stdlib");
    // `requests.get(...)` — `requests` is an external (non-relative) import.
    // The edge to_name is "get"; either it's classified via the external
    // import (when extractor records the receiver) OR via the .get(
    // instance_method heuristic. Both are acceptable non-NULL classifications.
    const getKind = byName.get("get");
    expect(["external_module", "instance_method", "stdlib"]).toContain(getKind);
    // `obj.method()` — instance method dispatch
    expect(byName.get("method")).toBe("instance_method");
    // `unknown_fn(x)` — nothing identifies it
    expect(byName.get("unknown_fn")).toBe("unknown");
  });

  it("leaves resolution_kind NULL for resolved edges", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const row = r.db
      .prepare(
        `SELECT COUNT(*) AS n FROM edges
          WHERE to_symbol_id IS NOT NULL AND resolution_kind IS NOT NULL`,
      )
      .get() as { n: number };
    expect(row.n).toBe(0);
  });
});
