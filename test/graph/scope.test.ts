import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
});
