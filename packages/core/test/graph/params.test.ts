import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexScope } from "../../src/graph/orchestrator.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "ts-dataflow");

interface ParamRow {
  position: number;
  name: string;
  type_text: string | null;
  has_default: number;
}

describe("params extraction (TypeScript)", () => {
  it("extracts (a: string, b: number = 5) for function foo", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const rows = r.db
      .prepare(
        `SELECT p.position, p.name, p.type_text, p.has_default
           FROM params p
           JOIN symbols s ON s.id = p.symbol_id
           JOIN files f ON f.id = s.file_id
          WHERE s.name = 'foo' AND f.path = 'params.ts'
          ORDER BY p.position`,
      )
      .all() as ParamRow[];

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      position: 0,
      name: "a",
      type_text: "string",
      has_default: 0,
    });
    expect(rows[1]).toMatchObject({
      position: 1,
      name: "b",
      type_text: "number",
      has_default: 1,
    });
  });

  it("emits zero rows for a no-arg function", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const count = (
      r.db
        .prepare(
          `SELECT count(*) AS n
             FROM params p
             JOIN symbols s ON s.id = p.symbol_id
            WHERE s.name = 'noParams'`,
        )
        .get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it("captures arrow-function params (arrowAdd: x, y)", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const rows = r.db
      .prepare(
        `SELECT p.position, p.name, p.type_text
           FROM params p
           JOIN symbols s ON s.id = p.symbol_id
          WHERE s.name = 'arrowAdd'
          ORDER BY p.position`,
      )
      .all() as ParamRow[];
    expect(rows.map((r) => r.name)).toEqual(["x", "y"]);
    expect(rows.every((r) => r.type_text === "number")).toBe(true);
  });

  it("captures method params (Greeter.greet: name, loud?)", async () => {
    const r = await indexScope({ repoRoot: FIXTURE });
    const rows = r.db
      .prepare(
        `SELECT p.position, p.name, p.has_default
           FROM params p
           JOIN symbols s ON s.id = p.symbol_id
           JOIN symbols c ON c.id = s.parent_id
          WHERE s.name = 'greet' AND c.name = 'Greeter'
          ORDER BY p.position`,
      )
      .all() as ParamRow[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe("name");
    expect(rows[1]!.name).toBe("loud");
    // Optional params (`loud?:`) → has_default=1.
    expect(rows[1]!.has_default).toBe(1);
  });
});
