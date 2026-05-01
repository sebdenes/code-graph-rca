import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexScope } from "../../src/graph/orchestrator.js";
import { recentlyChangedNear } from "../../src/graph/queries.js";

function git(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): void {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
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

  it("does not drop commits with empty author (squash-merge bots, anonymous)", async () => {
    // Regression: queries.ts previously did `if (!sha || !author || !date)
    // continue;` which silently dropped real commits whose `%an` resolved to
    // an empty string (squash-merge bots, anonymous contributors, malformed
    // .mailmap). The author field is decorative; only sha + date are
    // load-bearing for causal scoring. Verify such commits survive and the
    // author is surfaced as "unknown".
    //
    // git refuses to create such commits at the porcelain layer (`commit`)
    // AND at the `commit-tree` plumbing layer ("fatal: empty ident name").
    // To reproduce the real on-disk shape produced by misconfigured CI bots
    // and malformed .mailmap files, we hand-craft commit objects with an
    // empty author header and write them via `git hash-object -w`.
    const anonDir = mkdtempSync(join(tmpdir(), "cgrca-anon-"));
    try {
      git(anonDir, ["init", "-q"]);
      git(anonDir, ["config", "user.email", "committer@example.com"]);
      git(anonDir, ["config", "user.name", "Committer"]);
      git(anonDir, ["config", "commit.gpgsign", "false"]);

      const filePath = join(anonDir, "b.ts");

      const writeAnonCommit = (
        treeSha: string,
        parentSha: string | null,
        msg: string,
        timestamp: number,
      ): string => {
        const lines = [`tree ${treeSha}`];
        if (parentSha) lines.push(`parent ${parentSha}`);
        // Empty author name + empty email — exactly what bot-authored
        // commits and broken .mailmap entries produce in the wild.
        lines.push(`author  <> ${timestamp} +0000`);
        lines.push(`committer Committer <committer@example.com> ${timestamp} +0000`);
        lines.push("");
        lines.push(msg);
        const body = lines.join("\n") + "\n";
        const objPath = join(anonDir, `.git-anon-${timestamp}.txt`);
        writeFileSync(objPath, body, "utf8");
        const r = spawnSync(
          "git",
          ["-C", anonDir, "hash-object", "-t", "commit", "-w", objPath],
          { encoding: "utf8" },
        );
        rmSync(objPath, { force: true });
        if (r.status !== 0) {
          throw new Error(`hash-object failed: ${r.stderr}`);
        }
        return r.stdout.trim();
      };

      // Use "now" as the base timestamp so the commits fall inside any
      // reasonable --since window (large absolute timestamps like 100000
      // days ago overflow git's date parser and silently match nothing).
      const nowSec = Math.floor(Date.now() / 1000);

      // First revision: bar returns 1.
      writeFileSync(
        filePath,
        "export function bar() {\n  return 1;\n}\n",
        "utf8",
      );
      git(anonDir, ["add", "b.ts"]);
      const wt1 = spawnSync("git", ["-C", anonDir, "write-tree"], {
        encoding: "utf8",
      });
      expect(wt1.status).toBe(0);
      const sha1 = writeAnonCommit(wt1.stdout.trim(), null, "anon initial", nowSec - 60);
      git(anonDir, ["update-ref", "HEAD", sha1]);
      git(anonDir, ["reset", "-q", "--hard", "HEAD"]);

      // Second revision: bar returns 2 (modifies the symbol body).
      writeFileSync(
        filePath,
        "export function bar() {\n  return 2;\n}\n",
        "utf8",
      );
      git(anonDir, ["add", "b.ts"]);
      const wt2 = spawnSync("git", ["-C", anonDir, "write-tree"], {
        encoding: "utf8",
      });
      expect(wt2.status).toBe(0);
      const sha2 = writeAnonCommit(wt2.stdout.trim(), sha1, "anon tweak", nowSec);
      git(anonDir, ["update-ref", "HEAD", sha2]);
      git(anonDir, ["reset", "-q", "--hard", "HEAD"]);

      // Sanity check: %an really is empty for both commits on disk.
      const verify = spawnSync(
        "git",
        ["-C", anonDir, "log", "--format=[%an]"],
        { encoding: "utf8" },
      );
      expect(verify.status).toBe(0);
      expect(verify.stdout.trim().split("\n").every((l) => l === "[]")).toBe(true);

      const r = await indexScope({ repoRoot: anonDir });
      const changes = recentlyChangedNear(r.db, "bar", {
        repoRoot: anonDir,
        sinceDays: 365,
      });

      // Both anonymous commits must survive (load-bearing assertion).
      expect(changes.length).toBeGreaterThanOrEqual(2);
      for (const c of changes) {
        expect(c.symbolName).toBe("bar");
        expect(c.commit).toMatch(/^[0-9a-f]{40}$/);
        // Empty author surfaces as "unknown" rather than being dropped.
        expect(c.author).toBe("unknown");
      }
    } finally {
      rmSync(anonDir, { recursive: true, force: true });
    }
  });
});
