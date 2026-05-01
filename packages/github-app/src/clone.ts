import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface CloneOptions {
  /** HTTPS clone URL (e.g. pr.head.repo.clone_url). */
  cloneUrl: string;
  /** PR head sha to check out. */
  sha: string;
  /** Optional GitHub token for private clones (omit for public). */
  token?: string;
  /** Optional override of tmp dir prefix; mainly for tests. */
  tmpPrefix?: string;
}

export interface CloneResult {
  /** Absolute path to the freshly cloned worktree. */
  dir: string;
  /** Disposes the temp dir; safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Shallow clone a PR head into a fresh tmp dir, then check out the head sha.
 * Caller is responsible for invoking `cleanup()`.
 */
export function clonePrHead(opts: CloneOptions): CloneResult {
  const prefix = opts.tmpPrefix ?? "cgrca-gha-";
  const dir = mkdtempSync(join(tmpdir(), prefix));

  // Inject token into the URL when provided (for private repos / install tokens).
  let cloneUrl = opts.cloneUrl;
  if (opts.token && cloneUrl.startsWith("https://")) {
    cloneUrl = cloneUrl.replace(
      "https://",
      `https://x-access-token:${opts.token}@`,
    );
  }

  const cloneRes = spawnSync(
    "git",
    ["clone", "--depth=50", "--no-tags", cloneUrl, dir],
    { encoding: "utf8" },
  );
  if (cloneRes.status !== 0) {
    safeRm(dir);
    throw new Error(
      `git clone failed (${cloneRes.status}): ${cloneRes.stderr ?? ""}`,
    );
  }

  // Make sure we have the head sha (it may not be on the default branch tip).
  const fetchRes = spawnSync(
    "git",
    ["fetch", "--depth=50", "origin", opts.sha],
    { cwd: dir, encoding: "utf8" },
  );
  // fetch may fail on already-present sha; ignore unless checkout fails too.
  void fetchRes;

  const checkoutRes = spawnSync(
    "git",
    ["checkout", "--detach", opts.sha],
    { cwd: dir, encoding: "utf8" },
  );
  if (checkoutRes.status !== 0) {
    safeRm(dir);
    throw new Error(
      `git checkout ${opts.sha} failed (${checkoutRes.status}): ${checkoutRes.stderr ?? ""}`,
    );
  }

  let cleaned = false;
  return {
    dir,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      safeRm(dir);
    },
  };
}

function safeRm(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
