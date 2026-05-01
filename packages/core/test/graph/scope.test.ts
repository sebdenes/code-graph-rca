import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveScope } from "../../src/graph/scope.js";

const here = dirname(fileURLToPath(import.meta.url));
const TS_FIXTURE = join(here, "..", "fixtures", "ts-monorepo");
const PY_FIXTURE = join(here, "..", "fixtures", "py-package");

describe("resolveScope: file kind (TS monorepo)", () => {
  it("includes login.ts plus imported neighbors and workspace package files", () => {
    const r = resolveScope(
      { kind: "file", path: "packages/auth/src/login.ts" },
      TS_FIXTURE,
    );
    expect(r.seeds).toEqual(["packages/auth/src/login.ts"]);
    expect(r.files).toContain("packages/auth/src/login.ts");
    expect(r.files).toContain("packages/auth/src/hash.ts");
    expect(r.files).toContain("packages/auth/src/session.ts");
    // workspace package imports resolve into the package src
    expect(r.files.some((f) => f.startsWith("packages/shared/src/"))).toBe(true);
    expect(r.files.some((f) => f.startsWith("packages/config/src/"))).toBe(true);
    expect(r.primarySymbol).toBeNull();
  });

  it("findCallers: matches NodeNext .js specifiers via reverse search (regression)", () => {
    // `import { runRca } from "./rca/runner.js"` was being missed because the
    // regex required the basename to sit flush against the closing quote.
    const REPO = join(here, "..", "..");
    const r = resolveScope({ kind: "symbol", name: "runRca" }, REPO);
    expect(r.files).toContain("src/cli.ts"); // CLI calls runRca; must surface as a caller.
    expect(r.files).toContain("test/rca/runner.test.ts");
  });

  it("follows NodeNext-style imports that spell sibling .ts files as .js", () => {
    // Dog-food regression: cgrca was being run on its own src/, where every
    // import uses the NodeNext .js convention ("./scope.js" → ./scope.ts on
    // disk). The scope walker was appending alt extensions onto the .js
    // suffix instead of stripping it, so it returned only the seed file.
    const REPO = join(here, "..", "..");
    const r = resolveScope(
      { kind: "file", path: "src/rca/runner.ts" },
      REPO,
    );
    expect(r.files).toContain("src/rca/runner.ts");
    expect(r.files).toContain("src/graph/scope.ts");
    expect(r.files).toContain("src/graph/orchestrator.ts");
    expect(r.files).toContain("src/rca/context.ts");
    expect(r.files).toContain("src/rca/prompt.ts");
  });
});

describe("resolveScope: symbol kind (Python)", () => {
  it("seeds ingest.py and pulls in transform/validate/store via BFS", () => {
    const r = resolveScope({ kind: "symbol", name: "ingest" }, PY_FIXTURE);
    expect(r.primarySymbol).toBe("ingest");
    expect(r.seeds).toContain("src/fixture_pkg/ingest.py");
    expect(r.files).toContain("src/fixture_pkg/ingest.py");
    expect(r.files).toContain("src/fixture_pkg/transform.py");
    expect(r.files).toContain("src/fixture_pkg/validate.py");
    expect(r.files).toContain("src/fixture_pkg/store.py");
  });
});

describe("resolveScope: stack-trace kind", () => {
  it("extracts seed file and primary symbol from a Node-style stack", () => {
    const stack = `Error: invalid credentials
    at login (packages/auth/src/login.ts:25:11)
    at Object.<anonymous> (packages/auth/src/login.test.ts:8:5)`;
    const r = resolveScope({ kind: "stack-trace", text: stack }, TS_FIXTURE);
    expect(r.seeds).toContain("packages/auth/src/login.ts");
    expect(r.primarySymbol).toBe("login");
    expect(r.files).toContain("packages/auth/src/login.ts");
  });
});

describe("resolveScope: budget cap", () => {
  it("caps at maxFiles=1 and notes the cap", () => {
    const r = resolveScope(
      { kind: "file", path: "packages/auth/src/login.ts" },
      TS_FIXTURE,
      { maxFiles: 1 },
    );
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toBe("packages/auth/src/login.ts");
    expect(r.notes.some((n) => n.includes("cap"))).toBe(true);
  });

  it("caps the directory walk during scanRepo on large repos (regression)", () => {
    // Regression: scanRepo used to do a full recursive readdir BEFORE the
    // maxFiles cap was consulted. On a 100k-file repo this blocked the
    // event loop for tens of seconds and timed Cursor out. The cap must
    // now apply DURING the walk.
    const root = mkdtempSync(join(tmpdir(), "cgrca-scope-bigrepo-"));
    try {
      // 5000 files across 50 dirs of 100 files each, all parseable .ts.
      // Each file imports the next one to give the BFS something to chew on.
      const TOTAL = 5000;
      const PER_DIR = 100;
      for (let i = 0; i < TOTAL; i++) {
        const d = Math.floor(i / PER_DIR);
        const dir = join(root, `pkg${d}`);
        if (i % PER_DIR === 0) mkdirSync(dir, { recursive: true });
        const next = (i + 1) % TOTAL;
        const nextDir = Math.floor(next / PER_DIR);
        const importSpec = nextDir === d
          ? `./f${next % PER_DIR}.js`
          : `../pkg${nextDir}/f${next % PER_DIR}.js`;
        writeFileSync(
          join(dir, `f${i % PER_DIR}.ts`),
          `import { x as x${next} } from "${importSpec}";\nexport const x = ${i};\n`,
        );
      }
      // Seed the very first file. With maxFiles=100 and the cap applied
      // during the walk, scanRepo should stop after ~400 files (4 * cap)
      // and the whole call should finish well under 500ms even on a slow
      // CI box. A pre-fix run scanned all 5000 files synchronously.
      const t0 = Date.now();
      const r = resolveScope(
        { kind: "file", path: "pkg0/f0.ts" },
        root,
        { maxFiles: 100 },
      );
      const elapsed = Date.now() - t0;
      expect(r.seeds).toEqual(["pkg0/f0.ts"]);
      expect(r.files.length).toBeLessThanOrEqual(100);
      expect(r.files).toContain("pkg0/f0.ts");
      expect(elapsed).toBeLessThan(500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
