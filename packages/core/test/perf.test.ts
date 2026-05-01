import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { indexScope } from "../src/graph/orchestrator.js";
import { definitionOf, callersOf, calleesOf, symbolsInFile } from "../src/graph/queries.js";

/**
 * Synthetic 10k LOC scope: 100 TS files * ~100 LOC each. Each file declares
 * 3 functions, calls into the next file. Establishes the perf budget from
 * BUILD_PROMPT §5 and §11:
 *   - indexing 10k LOC < 5s
 *   - in-DB queries < 50ms
 */
function buildSyntheticRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cgrca-perf-"));
  const fileCount = 100;
  for (let i = 0; i < fileCount; i++) {
    const next = (i + 1) % fileCount;
    const lines: string[] = [];
    lines.push(`import { fn_${next}_a } from "./file${next}.js";`);
    for (let j = 0; j < 3; j++) {
      lines.push(`export function fn_${i}_${"abc"[j]}(x: number): number {`);
      for (let k = 0; k < 25; k++) lines.push(`  // line ${k}`);
      lines.push(`  return fn_${next}_a(x + ${j});`);
      lines.push(`}`);
      lines.push("");
    }
    writeFileSync(join(root, `file${i}.ts`), lines.join("\n"));
  }
  // Touch a tsconfig so the dir looks plausible.
  writeFileSync(join(root, "tsconfig.json"), "{}");
  return root;
}

describe("perf smoke (10k LOC)", () => {
  it("indexes < 5s and queries < 50ms", async () => {
    const root = buildSyntheticRepo();
    const t0 = performance.now();
    const r = await indexScope({ repoRoot: root });
    const indexMs = performance.now() - t0;

    expect(r.fileCount).toBe(101); // 100 .ts + tsconfig.json (unparsed)
    expect(r.symbolCount).toBeGreaterThanOrEqual(300);
    expect(indexMs).toBeLessThan(5_000);

    const q1 = performance.now();
    definitionOf(r.db, "fn_0_a");
    expect(performance.now() - q1).toBeLessThan(50);

    const q2 = performance.now();
    callersOf(r.db, "fn_5_a", { depth: 2 });
    expect(performance.now() - q2).toBeLessThan(50);

    const q3 = performance.now();
    calleesOf(r.db, "fn_5_a", { depth: 1 });
    expect(performance.now() - q3).toBeLessThan(50);

    const q4 = performance.now();
    symbolsInFile(r.db, "file5.ts");
    expect(performance.now() - q4).toBeLessThan(50);

    r.db.close();
  });
});
