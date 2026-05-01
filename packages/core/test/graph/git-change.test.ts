import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexScope } from "../../src/graph/orchestrator.js";
import { recentlyChangedNear } from "../../src/graph/queries.js";

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: status=${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`,
    );
  }
}

describe("recentlyChangedNear", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cgrca-"));
    git(tmpDir, ["init", "-q"]);
    git(tmpDir, ["config", "user.email", "test@example.com"]);
    git(tmpDir, ["config", "user.name", "Test User"]);
    // Make sure commits don't get GPG-signed in CI environments where
    // signing might be globally enabled but unconfigured here.
    git(tmpDir, ["config", "commit.gpgsign", "false"]);

    const filePath = join(tmpDir, "a.ts");
    writeFileSync(
      filePath,
      "export function foo() {\n  return 1;\n}\n",
      "utf8",
    );
    git(tmpDir, ["add", "a.ts"]);
    git(tmpDir, ["commit", "-q", "-m", "add foo"]);

    // Modify the function body and commit again.
    writeFileSync(
      filePath,
      "export function foo() {\n  return 2;\n}\n",
      "utf8",
    );
    git(tmpDir, ["add", "a.ts"]);
    git(tmpDir, ["commit", "-q", "-m", "tweak foo"]);
  });

  afterAll(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns recent commits touching the symbol, newest first", async () => {
    const r = await indexScope({ repoRoot: tmpDir });
    const changes = recentlyChangedNear(r.db, "foo", {
      repoRoot: tmpDir,
      sinceDays: 365,
    });
    expect(changes.length).toBeGreaterThanOrEqual(2);
    for (const c of changes) {
      expect(c.symbolName).toBe("foo");
      expect(c.file).toBe("a.ts");
      expect(c.commit).toMatch(/^[0-9a-f]{40}$/);
    }
    for (let i = 1; i < changes.length; i++) {
      const prev = changes[i - 1]!;
      const cur = changes[i]!;
      expect(prev.date >= cur.date).toBe(true);
    }
  });

  it("returns [] for an unknown symbol name", async () => {
    const r = await indexScope({ repoRoot: tmpDir });
    const changes = recentlyChangedNear(r.db, "nonexistent", {
      repoRoot: tmpDir,
    });
    expect(changes).toEqual([]);
  });

  it("returns [] gracefully when repoRoot is not a git repo", async () => {
    const r = await indexScope({ repoRoot: tmpDir });
    const nonRepo = mkdtempSync(join(tmpdir(), "cgrca-nogit-"));
    try {
      const changes = recentlyChangedNear(r.db, "foo", { repoRoot: nonRepo });
      expect(changes).toEqual([]);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
