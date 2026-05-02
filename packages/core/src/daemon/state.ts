import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * On-disk layout for cgrcad. Single root under ~/.cgrca, owned by the
 * current user. Per-repo sqlite files are content-addressed by the
 * realpath of the repo root, so two checkouts that resolve to the same
 * path share the same graph (and two distinct checkouts don't collide).
 */

export const ROOT = join(homedir(), ".cgrca");
export const REPOS_DIR = join(ROOT, "repos");
export const SOCKET_PATH = join(ROOT, "daemon.sock");
export const LOCK_PATH = join(ROOT, "daemon.lock");

export function ensureRoot(): void {
  mkdirSync(REPOS_DIR, { recursive: true });
}

/** Hash the realpath of a repo root into the on-disk filename. */
export function repoDbPath(repoRoot: string): string {
  let real: string;
  try {
    real = realpathSync(resolve(repoRoot));
  } catch {
    real = resolve(repoRoot);
  }
  const sha = createHash("sha256").update(real).digest("hex").slice(0, 16);
  return join(REPOS_DIR, `${sha}.sqlite`);
}
