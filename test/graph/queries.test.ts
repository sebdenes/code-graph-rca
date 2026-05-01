import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexScope } from "../../src/graph/orchestrator.js";
import { definitionOf, symbolsInFile, calleesOf } from "../../src/graph/queries.js";

const here = dirname(fileURLToPath(import.meta.url));
const TINY_FIXTURE = join(here, "..", "fixtures", "ts-tiny");

describe("ts-tiny: end-to-end definitionOf vertical", () => {
  it("indexes the fixture and finds definitionOf foo", async () => {
    const r = await indexScope({ repoRoot: TINY_FIXTURE });
    expect(r.fileCount).toBe(2);
    expect(r.symbolCount).toBeGreaterThanOrEqual(4);

    const defs = definitionOf(r.db, "foo");
    expect(defs).toHaveLength(1);
    const def = defs[0]!;
    expect(def.kind).toBe("function");
    expect(def.file).toBe("a.ts");
    expect(def.startLine).toBe(1);
    expect(def.exported).toBe(true);
    expect(def.language).toBe("typescript");
  });

  it("symbolsInFile lists exported function and class", async () => {
    const r = await indexScope({ repoRoot: TINY_FIXTURE });
    const syms = symbolsInFile(r.db, "a.ts");
    const names = syms.map((s) => s.name).sort();
    expect(names).toContain("foo");
    expect(names).toContain("Greeter");
    expect(names).toContain("greet");
    const greeter = syms.find((s) => s.name === "Greeter")!;
    expect(greeter.kind).toBe("class");
    expect(greeter.exported).toBe(true);
  });

  it("calleesOf bar finds local foo and Greeter.greet", async () => {
    const r = await indexScope({ repoRoot: TINY_FIXTURE });
    const tree = calleesOf(r.db, "bar");
    const names = tree.callees.map((c) => c.name).sort();
    expect(names).toContain("foo");
    expect(names).toContain("greet");
  });
});
