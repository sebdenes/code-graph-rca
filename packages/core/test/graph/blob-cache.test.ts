/**
 * Blob-sha cache integration tests.
 *
 * Verifies the orchestrator skips tree-sitter on files whose `git
 * hash-object` matches the cached row, and re-extracts only the dirty
 * file when one source changes between runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

// Counter wired around the real extractor. We can't easily use vi.mock
// here because the orchestrator imports `extractFile` by binding at
// module load; instead we wrap via spy on the imported namespace.
import * as extractMod from "../../src/graph/parser/extract.js";
import { indexScope } from "../../src/graph/orchestrator.js";

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cgrca-blobcache-"));
  // Init a git repo so `batchHashObjects` succeeds.
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["-C", root, "config", "user.email", "t@t"]);
  spawnSync("git", ["-C", root, "config", "user.name", "t"]);
  for (let i = 0; i < 5; i++) {
    const next = (i + 1) % 5;
    const lines = [
      `import { fn_${next} } from "./file${next}.js";`,
      `export function fn_${i}(x: number): number {`,
      `  return fn_${next}(x + ${i});`,
      `}`,
    ];
    writeFileSync(join(root, `file${i}.ts`), lines.join("\n") + "\n");
  }
  spawnSync("git", ["-C", root, "add", "."]);
  spawnSync("git", ["-C", root, "commit", "-q", "-m", "init"]);
  return root;
}

describe("blob-sha cache: warm re-index skips tree-sitter", () => {
  let root: string;
  let dbPath: string;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = makeFixture();
    dbPath = join(root, ".cgrca.sqlite");
    spy = vi.spyOn(extractMod, "extractFile");
  });

  afterEach(() => {
    spy.mockRestore();
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("run 1 extracts every file; run 2 extracts none and is faster", async () => {
    const t1 = performance.now();
    const r1 = await indexScope({ repoRoot: root, persist: dbPath });
    const cold = performance.now() - t1;
    expect(r1.fileCount).toBeGreaterThanOrEqual(5);
    expect(spy).toHaveBeenCalledTimes(5);
    r1.db.close();

    spy.mockClear();

    const t2 = performance.now();
    const r2 = await indexScope({ repoRoot: root, persist: dbPath });
    const warm = performance.now() - t2;
    expect(r2.fileCount).toBeGreaterThanOrEqual(5);
    expect(spy).toHaveBeenCalledTimes(0);
    r2.db.close();

    // Warm should be meaningfully faster. We assert >=30% reduction
    // here because at a 5-file fixture much of cold time is parser load
    // (amortized) and the absolute numbers are tens of milliseconds —
    // making a tighter ratio flaky on shared CI. The strong correctness
    // signal is the spy counts above (5 calls cold, 0 calls warm);
    // timing here is a sanity check that the cache is on the hot path.
    expect(warm).toBeLessThan(cold * 0.7);
  });

  it("modify one file → only that file is re-extracted", async () => {
    const r1 = await indexScope({ repoRoot: root, persist: dbPath });
    expect(spy).toHaveBeenCalledTimes(5);
    r1.db.close();

    spy.mockClear();
    appendFileSync(join(root, "file2.ts"), "\nexport const dirty = 1;\n");

    const r2 = await indexScope({ repoRoot: root, persist: dbPath });
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]?.[0] as { relPath: string } | undefined;
    expect(arg?.relPath).toBe("file2.ts");
    r2.db.close();
  });
});

describe("blob-sha cache: sha256 fallback outside git", () => {
  let root: string;
  let dbPath: string;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // No `git init` here → batchHashObjects returns empty, code falls
    // back to in-process sha256.
    root = mkdtempSync(join(tmpdir(), "cgrca-blobcache-nogit-"));
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(root, `file${i}.ts`), `export const x_${i} = ${i};\n`);
    }
    dbPath = join(root, ".cgrca.sqlite");
    spy = vi.spyOn(extractMod, "extractFile");
  });

  afterEach(() => {
    spy.mockRestore();
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("warm run still skips tree-sitter via sha256 fallback", async () => {
    const r1 = await indexScope({ repoRoot: root, persist: dbPath });
    expect(spy).toHaveBeenCalledTimes(3);
    r1.db.close();

    spy.mockClear();
    const r2 = await indexScope({ repoRoot: root, persist: dbPath });
    expect(spy).toHaveBeenCalledTimes(0);
    r2.db.close();
  });
});
