import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { LOCK_PATH, ensureRoot } from "./state.js";

export interface LockInfo {
  pid: number;
  startedAt: number;
}

/**
 * Returns true if the lock was acquired (we are now the daemon). Returns
 * false if a *live* daemon already holds the lock — caller should bail.
 *
 * Stale lockfiles (PID no longer alive) are reclaimed transparently.
 */
export function acquireLock(): boolean {
  ensureRoot();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      const info: LockInfo = { pid: process.pid, startedAt: Date.now() };
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!isLiveLock()) {
        try { unlinkSync(LOCK_PATH); } catch { /* race: another reclaimer won */ }
        continue;
      }
      return false;
    }
  }
  return false;
}

export function releaseLock(): void {
  try { unlinkSync(LOCK_PATH); } catch { /* already gone */ }
}

export function readLock(): LockInfo | null {
  try {
    const text = readFileSync(LOCK_PATH, "utf8");
    const parsed = JSON.parse(text) as LockInfo;
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True if the lockfile exists AND its PID is still alive. */
export function isLiveLock(): boolean {
  const info = readLock();
  if (!info) return false;
  try {
    // Signal 0 doesn't deliver — it just probes.
    process.kill(info.pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it (different uid):
    // treat as live; we shouldn't clobber another user's daemon.
    if (code === "EPERM") return true;
    return false;
  }
}
