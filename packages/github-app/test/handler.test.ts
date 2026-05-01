import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { handlePullRequest, type PrPayload } from "../src/handler.js";
import { COMMENT_MARKER } from "../src/comment.js";
import type { PrCommentApi } from "../src/types.js";
import type { ChangedFile } from "../src/changed-symbols.js";

interface CapturedComment {
  body: string;
  action: "created" | "updated";
  id: number;
}

function makeCapturingOctokit(captures: CapturedComment[]): PrCommentApi {
  let nextId = 1000;
  const comments: Array<{ id: number; body: string }> = [];
  return {
    issues: {
      listComments: async () => ({
        data: comments.map((c) => ({ id: c.id, user: { login: "cgrca[bot]" }, body: c.body })),
      }),
      createComment: async (args) => {
        const id = nextId++;
        comments.push({ id, body: args.body });
        captures.push({ body: args.body, action: "created", id });
        return { data: { id, body: args.body } };
      },
      updateComment: async (args) => {
        const c = comments.find((x) => x.id === args.comment_id);
        if (c) c.body = args.body;
        captures.push({ body: args.body, action: "updated", id: args.comment_id });
        return { data: { id: args.comment_id, body: args.body } };
      },
    },
    pulls: {
      listFiles: async () => ({ data: [] }),
    },
  };
}

function makeFixtureRepo(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "cgrca-gha-fix-"));
  // a.ts has a function `login` that calls `verifyPassword`.
  writeFileSync(
    join(root, "a.ts"),
    `export function verifyPassword(p: string): boolean {
  return p.length > 4;
}

export function login(user: string, pass: string): string {
  if (!verifyPassword(pass)) throw new Error("nope");
  return "ok-" + user;
}
`,
  );
  // b.ts calls login.
  writeFileSync(
    join(root, "b.ts"),
    `import { login } from "./a.js";

export function handleLoginRoute(): string {
  return login("alice", "secret-password");
}
`,
  );

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Tester",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "Tester",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, env });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root, env });
  spawnSync("git", ["add", "."], { cwd: root, env });
  spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: root, env });
  // Now modify login on a "branch" — for this test we just simulate by
  // overwriting + leaving the worktree there; PR diff is supplied directly.
  writeFileSync(
    join(root, "a.ts"),
    `export function verifyPassword(p: string): boolean {
  return p.length >= 8; // tightened
}

export function login(user: string, pass: string): string {
  if (!verifyPassword(pass)) throw new Error("bad password");
  return "ok-" + user;
}
`,
  );
  const shaRes = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  return { root, sha: (shaRes.stdout ?? "").trim() };
}

function basePayload(sha: string): PrPayload {
  return {
    action: "opened",
    number: 42,
    pull_request: {
      number: 42,
      head: {
        sha,
        ref: "feature/login-tighten",
        repo: { clone_url: "https://example.invalid/repo.git", full_name: "o/r" },
      },
      base: { repo: { full_name: "o/r", owner: { login: "o" }, name: "r" } },
    },
    repository: { full_name: "o/r", name: "r", owner: { login: "o" } },
  };
}

describe("handlePullRequest end-to-end", () => {
  it("posts a comment naming the changed function", async () => {
    const { root, sha } = makeFixtureRepo();
    const captures: CapturedComment[] = [];
    const octokit = makeCapturingOctokit(captures);

    const changedFiles: ChangedFile[] = [
      {
        path: "a.ts",
        status: "modified",
        // Cover lines 5–8 (inside `login`).
        hunks: [{ startLine: 5, endLine: 8 }],
      },
    ];

    const result = await handlePullRequest({
      octokit,
      payload: basePayload(sha),
      worktreeOverride: root,
      changedFilesOverride: changedFiles,
    });

    expect(result.status).toBe("posted");
    expect(result.commentAction).toBe("created");
    expect(result.changedSymbolCount).toBeGreaterThanOrEqual(1);
    expect(captures.length).toBe(1);
    const body = captures[0]?.body ?? "";
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain("cgrca review");
    expect(body).toContain("login");
    expect(body).toContain("Changed symbols:");
  });

  it("skips with the short comment when only docs change", async () => {
    const { root, sha } = makeFixtureRepo();
    // Add a markdown file so the worktree has something to "change".
    writeFileSync(join(root, "README.md"), "# hello\n");
    const captures: CapturedComment[] = [];
    const octokit = makeCapturingOctokit(captures);

    const changedFiles: ChangedFile[] = [
      { path: "README.md", status: "added", hunks: [] },
      { path: "package.json", status: "modified", hunks: [{ startLine: 1, endLine: 5 }] },
    ];

    const result = await handlePullRequest({
      octokit,
      payload: basePayload(sha),
      worktreeOverride: root,
      changedFilesOverride: changedFiles,
    });

    expect(result.status).toBe("skipped-no-symbols");
    expect(captures.length).toBe(1);
    const body = captures[0]?.body ?? "";
    expect(body).toContain("docs/config-only PR");
    expect(body).not.toContain("Changed symbols:");
  });

  it("updates the same comment on a synchronize event (idempotency)", async () => {
    const { root, sha } = makeFixtureRepo();
    const captures: CapturedComment[] = [];
    const octokit = makeCapturingOctokit(captures);

    const changedFiles: ChangedFile[] = [
      { path: "a.ts", status: "modified", hunks: [{ startLine: 5, endLine: 8 }] },
    ];

    const r1 = await handlePullRequest({
      octokit,
      payload: basePayload(sha),
      worktreeOverride: root,
      changedFilesOverride: changedFiles,
    });
    expect(r1.commentAction).toBe("created");

    const r2 = await handlePullRequest({
      octokit,
      payload: { ...basePayload(sha), action: "synchronize" },
      worktreeOverride: root,
      changedFilesOverride: changedFiles,
    });
    expect(r2.commentAction).toBe("updated");
    expect(r2.commentId).toBe(r1.commentId);

    // Two captures total; first created, second updated.
    expect(captures.length).toBe(2);
    expect(captures[0]?.action).toBe("created");
    expect(captures[1]?.action).toBe("updated");
  });
});
