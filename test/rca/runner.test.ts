import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { runRca } from "../../src/rca/runner.js";
import type { CalleeTree, Definition } from "../../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const TS_FIXTURE = join(here, "..", "fixtures", "ts-monorepo");
const PY_FIXTURE = join(here, "..", "fixtures", "py-package");

describe("runRca", () => {
  it("ts planted bug via failing-test seeds the auth scope", async () => {
    const result = await runRca({
      failureScope: { kind: "failing-test", path: "packages/auth/src/login.test.ts" },
      repoRoot: TS_FIXTURE,
    });
    expect(result.scope.files).toContain("packages/auth/src/login.ts");
    expect(result.scope.files).toContain("packages/auth/src/hash.ts");
    expect(result.scope.files).toContain("packages/auth/src/session.ts");
    expect(typeof result.graphContext).toBe("string");
    expect(result.graphContext.length).toBeGreaterThan(0);
    expect(result.prompt).toContain("Root-cause-analysis protocol");
    expect(result.prompt).toContain("Top causal candidates");
    expect(result.prompt).toContain("First hypothesis");
    expect(Array.isArray(result.causalCandidates)).toBe(true);
    const candidateFiles = result.causalCandidates.map((c) => c.file);
    expect(candidateFiles).toContain("packages/auth/src/login.ts");
  });

  it("ts planted bug via symbol pins login as anchor", async () => {
    const result = await runRca({
      failureScope: { kind: "symbol", name: "login" },
      repoRoot: TS_FIXTURE,
    });
    expect(result.primarySymbol).toBe("login");
    const defQuery = result.queries.find((q) => q.name === "definitionOf");
    expect(defQuery).toBeDefined();
    const defs = defQuery!.result as Definition[];
    expect(defs.length).toBeGreaterThan(0);
    expect(defs.some((d) => d.file === "packages/auth/src/login.ts")).toBe(true);
  });

  it("python planted bug via symbol resolves ingest neighborhood", async () => {
    const result = await runRca({
      failureScope: { kind: "symbol", name: "ingest" },
      repoRoot: PY_FIXTURE,
    });
    expect(result.primarySymbol).toBe("ingest");
    const calleesQ = result.queries.find((q) => q.name === "calleesOf");
    expect(calleesQ).toBeDefined();
    const tree = calleesQ!.result as CalleeTree;
    const names = tree.callees.map((c) => c.name);
    expect(names).toContain("validate");
    expect(names).toContain("apply");
    expect(names).toContain("save");
    expect(result.graphContext).toContain("validate");
    expect(result.graphContext).toContain("ingest.py");
    expect(Array.isArray(result.causalCandidates)).toBe(true);
    const candidateFiles = result.causalCandidates.map((c) => c.file);
    expect(candidateFiles).toContain("src/fixture_pkg/ingest.py");
    expect(result.prompt).toContain("Top causal candidates");
    expect(result.prompt).toContain("First hypothesis");
  });

  it("empty repo / nonexistent file returns empty queries with note", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "rca-empty-"));
    const result = await runRca({
      failureScope: { kind: "file", path: "nonexistent.ts" },
      repoRoot: tmp,
    });
    expect(result.queries).toEqual([]);
    expect(result.notes.some((n) => n.includes("no seed"))).toBe(true);
    expect(typeof result.prompt).toBe("string");
    expect(Array.isArray(result.causalCandidates)).toBe(true);
    expect(result.causalCandidates.length).toBe(0);
    expect(result.firstHypothesis).toBeNull();
    expect(result.prompt).toContain("Top causal candidates");
    expect(result.prompt).toContain("First hypothesis");
  });
});
