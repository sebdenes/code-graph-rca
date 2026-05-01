import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walk } from "../../src/graph/walker.js";

describe("walk: symlink loop guard", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cgrca-walker-symlink-"));
    writeFileSync(join(dir, "real.ts"), "export const x = 1;\n");
    // Create the loop: a symlink pointing at the directory containing it.
    symlinkSync(".", join(dir, "loop"));
  });

  afterAll(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("terminates and returns the real file exactly once", () => {
    const start = Date.now();
    const files = walk(dir);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);

    const real = files.filter((f) => f.relPath.endsWith("real.ts"));
    expect(real.length).toBe(1);
  });
});

describe("walk: lex-sorted output", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cgrca-walker-sort-"));
    // Write in non-alphabetical order so any naive FS-order traversal would
    // surface b before a on at least some filesystems.
    writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "c.ts"), "export const c = 1;\n");
    // Subdir to make sure intra-dir sorting holds at depth too.
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "z.ts"), "export const z = 1;\n");
    writeFileSync(join(dir, "sub", "y.ts"), "export const y = 1;\n");
  });

  afterAll(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("emits files in lexicographic order regardless of FS order", () => {
    const files = walk(dir).map((f) => f.relPath);
    expect(files).toEqual(["a.ts", "b.ts", "c.ts", "sub/y.ts", "sub/z.ts"]);
  });
});
