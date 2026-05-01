import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexScope } from "../../src/graph/orchestrator.js";
import { callersOf, calleesOf } from "../../src/graph/queries.js";
import {
  createRecencyHydrator,
  hydrateCallerTree,
  hydrateCalleeTree,
} from "../../src/rca/recency.js";

function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): void {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: status=${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`,
    );
  }
}

function commitWithDate(
  cwd: string,
  message: string,
  isoDate: string,
): void {
  git(cwd, ["commit", "-q", "-m", message], {
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  });
}

describe("recency hydrator", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cgrca-recency-"));
    git(tmpDir, ["init", "-q", "-b", "main"]);
    git(tmpDir, ["config", "user.email", "test@example.com"]);
    git(tmpDir, ["config", "user.name", "Test User"]);
    git(tmpDir, ["config", "commit.gpgsign", "false"]);

    const aPath = join(tmpDir, "a.ts");
    const bPath = join(tmpDir, "b.ts");

    // commit 1: a.ts foo v1 (older)
    writeFileSync(
      aPath,
      "export function foo(x: number): number {\n  return x + 1;\n}\n",
      "utf8",
    );
    git(tmpDir, ["add", "a.ts"]);
    commitWithDate(tmpDir, "add foo", "2024-01-01T12:00:00Z");

    // commit 2: a.ts foo v2 (newer)
    writeFileSync(
      aPath,
      "export function foo(x: number): number {\n  return x + 2;\n}\n",
      "utf8",
    );
    git(tmpDir, ["add", "a.ts"]);
    commitWithDate(tmpDir, "tweak foo", "2024-06-01T12:00:00Z");

    // commit 3: b.ts bar that calls foo
    writeFileSync(
      bPath,
      "import { foo } from \"./a.js\";\n\nexport function bar(): number {\n  return foo(41);\n}\n",
      "utf8",
    );
    git(tmpDir, ["add", "b.ts"]);
    commitWithDate(tmpDir, "add bar", "2024-06-15T12:00:00Z");
  });

  afterAll(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("hydrates the caller tree with recentChanges", async () => {
    const r = await indexScope({ repoRoot: tmpDir });
    const tree = callersOf(r.db, "foo", {
      hydrateRecency: { repoRoot: tmpDir, sinceDays: 10000 },
    });
    expect(tree.callers.length).toBeGreaterThanOrEqual(1);
    const barNode = tree.callers.find((n) => n.name === "bar");
    expect(barNode).toBeDefined();
    expect(barNode!.recentChanges).toBeDefined();
    expect(barNode!.recentChanges!.length).toBeGreaterThanOrEqual(1);
    const change = barNode!.recentChanges![0]!;
    expect(change.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof change.daysAgo).toBe("number");
    expect(change.subject.length).toBeGreaterThan(0);
  });

  it("hydrates a callee tree: foo (resolved callee) has 2 commits", async () => {
    const r = await indexScope({ repoRoot: tmpDir });
    const tree = calleesOf(r.db, "bar", {
      hydrateRecency: { repoRoot: tmpDir, sinceDays: 10000 },
    });
    const fooNode = tree.callees.find((n) => n.name === "foo");
    expect(fooNode).toBeDefined();
    expect(fooNode!.resolved).toBe(true);
    expect(fooNode!.recentChanges).toBeDefined();
    expect(fooNode!.recentChanges!.length).toBe(2);
  });

  it("caches per (file, start, end); second hydration adds no invocations", async () => {
    const r = await indexScope({ repoRoot: tmpDir });
    const tree = callersOf(r.db, "foo");
    const hydrator = createRecencyHydrator({
      repoRoot: tmpDir,
      sinceDays: 10000,
    });
    hydrateCallerTree(tree, r.db, hydrator);
    const firstInvocations = hydrator.invocations;
    expect(firstInvocations).toBeGreaterThan(0);
    expect(firstInvocations).toBeLessThanOrEqual(tree.callers.length + 5);

    const before = hydrator.invocations;
    hydrateCallerTree(tree, r.db, hydrator);
    expect(hydrator.invocations).toBe(before);
    expect(hydrator.cacheHits).toBeGreaterThan(0);
  });

  it("returns empty arrays without throwing when repoRoot is not a git repo", async () => {
    const r = await indexScope({ repoRoot: tmpDir });
    const nonRepo = mkdtempSync(join(tmpdir(), "cgrca-nogit-"));
    try {
      const tree = callersOf(r.db, "foo", {
        hydrateRecency: { repoRoot: nonRepo, sinceDays: 10000 },
      });
      for (const node of tree.callers) {
        expect(node.recentChanges).toEqual([]);
      }
      // also test direct hydrator on a callee tree
      const calleeTree = calleesOf(r.db, "bar");
      const hydrator = createRecencyHydrator({ repoRoot: nonRepo });
      expect(() => hydrateCalleeTree(calleeTree, r.db, hydrator)).not.toThrow();
      for (const node of calleeTree.callees) {
        expect(node.recentChanges).toEqual([]);
      }
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("respects maxLookups cap", async () => {
    const r = await indexScope({ repoRoot: tmpDir });
    const tree = callersOf(r.db, "foo");
    const hydrator = createRecencyHydrator({
      repoRoot: tmpDir,
      sinceDays: 10000,
      maxLookups: 0,
    });
    hydrateCallerTree(tree, r.db, hydrator);
    expect(hydrator.invocations).toBe(0);
    for (const node of tree.callers) {
      expect(node.recentChanges).toEqual([]);
    }
  });
});
