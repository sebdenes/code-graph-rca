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
function buildSyntheticRepo(opts: { fileCount?: number } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cgrca-perf-"));
  const fileCount = opts.fileCount ?? 100;
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

/**
 * 50k LOC scope: 500 TS files * ~100 LOC each. Sized to catch query-compile
 * cache regressions — the per-file `lang.query(querySrc)` recompile was 6ms
 * apiece, accumulating to seconds at this scale. With caching we expect
 * indexing to stay well under 8s on dev hardware.
 */
describe("perf regression (50k LOC, query-compile cache)", () => {
  it("indexes 500 files under 8s", async () => {
    const root = buildSyntheticRepo({ fileCount: 500 });
    const t0 = performance.now();
    const r = await indexScope({ repoRoot: root });
    const indexMs = performance.now() - t0;

    expect(r.fileCount).toBe(501); // 500 .ts + tsconfig.json (unparsed)
    expect(r.symbolCount).toBeGreaterThanOrEqual(1500);
    expect(indexMs).toBeLessThan(8_000);

    r.db.close();
  }, 30_000);
});

/**
 * Warm re-index regression: a persisted DB with a populated FK chain used to
 * spend most of the second-run wall in a per-row FK-cascade DELETE at the
 * top of `indexScope`. With `foreign_keys = OFF` wrapping the bulk clear,
 * the second run should land within ~2× the cold run rather than the 3-4×
 * we used to see on large repos. We measure on a synthetic 500-file repo so CI
 * has real signal without depending on any specific repo. (We tried
 * `defer_foreign_keys = ON` first; SQLite still scans every row at COMMIT,
 * so deferred FK didn't help — see the orchestrator comment for measured
 * timings.)
 */
describe("perf regression (warm re-index, FK-off bulk clear)", () => {
  it("warm re-index of a persisted DB stays within 2x the cold run", async () => {
    const root = buildSyntheticRepo({ fileCount: 500 });
    const persist = join(
      mkdtempSync(join(tmpdir(), "cgrca-warm-")),
      "graph.sqlite",
    );

    const t0 = performance.now();
    const cold = await indexScope({ repoRoot: root, persist });
    const coldMs = performance.now() - t0;
    cold.db.close();

    const t1 = performance.now();
    const warm = await indexScope({ repoRoot: root, persist });
    const warmMs = performance.now() - t1;

    expect(warm.fileCount).toBe(cold.fileCount);
    expect(warm.symbolCount).toBe(cold.symbolCount);
    expect(warm.edgeCount).toBe(cold.edgeCount);
    // The clear+reload should not blow past the cold parse-from-scratch.
    // 2× gives generous headroom for CI noise; the regression we're guarding
    // against measured 3-4× before the FK-off clear landed.
    expect(warmMs).toBeLessThan(coldMs * 2);

    warm.db.close();
  }, 60_000);
});
