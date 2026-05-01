import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexScope } from "../../src/graph/orchestrator.js";
import {
  definitionOf,
  symbolsInFile,
  calleesOf,
  callersOf,
} from "../../src/graph/queries.js";

const here = dirname(fileURLToPath(import.meta.url));
const PY_FIXTURE = join(here, "..", "fixtures", "py-package");

describe("py-package: Python extraction", () => {
  it("indexes ingest.py and finds the function", async () => {
    const r = await indexScope({ repoRoot: PY_FIXTURE });
    expect(r.fileCount).toBeGreaterThanOrEqual(5);
    const defs = definitionOf(r.db, "ingest", { language: "python" });
    expect(defs).toHaveLength(1);
    const def = defs[0]!;
    expect(def.kind).toBe("function");
    expect(def.file).toContain("ingest.py");
  });

  it("symbolsInFile transform.py finds Transformer.apply method", async () => {
    const r = await indexScope({ repoRoot: PY_FIXTURE });
    const path = "src/fixture_pkg/transform.py";
    const syms = symbolsInFile(r.db, path);
    const names = syms.map((s) => s.name).sort();
    expect(names).toContain("Transformer");
    expect(names).toContain("apply");
    const t = syms.find((s) => s.name === "Transformer")!;
    expect(t.kind).toBe("class");
    const apply = syms.find((s) => s.name === "apply")!;
    expect(apply.kind).toBe("method");
  });

  it("calleesOf ingest finds apply, validate, save", async () => {
    const r = await indexScope({ repoRoot: PY_FIXTURE });
    const tree = calleesOf(r.db, "ingest");
    const names = tree.callees.map((c) => c.name).sort();
    expect(names).toContain("apply");
    expect(names).toContain("validate");
    expect(names).toContain("save");
  });

  it("callersOf normalize_key finds apply (cross-file resolution required)", async () => {
    const r = await indexScope({ repoRoot: PY_FIXTURE });
    const tree = callersOf(r.db, "normalize_key", { depth: 2, minConfidence: 0.0 });
    const allCallers = collectAll(tree.callers);
    expect(allCallers).toContain("apply");
  });
});

function collectAll(nodes: Array<{ name: string; callers: Array<{ name: string; callers: unknown[] }> }>): string[] {
  const out: string[] = [];
  function walk(ns: typeof nodes): void {
    for (const n of ns) {
      out.push(n.name);
      walk(n.callers as typeof nodes);
    }
  }
  walk(nodes);
  return out;
}
