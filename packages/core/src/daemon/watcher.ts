import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import type { Ignore } from "ignore";
import type { Db } from "../graph/db.js";
import { languageOf } from "../graph/walker.js";
import { reExtractFile, removeFile } from "./reextract.js";

const requireFromHere = createRequire(import.meta.url);
const ignore = requireFromHere("ignore") as (
  options?: { ignorecase?: boolean },
) => Ignore;

/**
 * Recursive fs.watch invalidator. On a file change inside `repoRoot`, drop
 * its rows and re-extract. Bursts of saves (e.g. an editor's atomic write
 * that emits rename+change in quick succession) collapse into one
 * re-extract via a 150ms debounce.
 *
 * macOS notes:
 *  - `fs.watch(dir, { recursive: true })` is supported on Darwin since
 *    Node 19 and uses FSEvents under the hood. It does NOT follow symlinks
 *    (matching our walker's intent).
 *  - On very large trees (>~10k watched files) a Node process can hit
 *    macOS's per-process EMFILE / kqueue limit. We don't open per-file
 *    watchers — recursive watch is one FSEvents stream — so this is rarely
 *    a problem in practice. If it ever is, raise `ulimit -n`.
 *  - Atomic-save editors (vim with `:w`, VSCode default) trigger rename
 *    events; the debounce + re-extract path handles them as updates.
 */

// Mirrors walker.ts to keep watcher and indexer in sync.
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".tox",
]);

const DEBOUNCE_MS = 150;

export interface RepoWatcher {
  close: () => void;
  /** Test hook: resolves once any in-flight debounce has been processed. */
  flush: () => Promise<void>;
}

function loadGitignore(repoRoot: string): Ignore {
  const ig = ignore();
  const gi = join(repoRoot, ".gitignore");
  if (existsSync(gi)) {
    try {
      ig.add(readFileSync(gi, "utf8"));
    } catch {
      /* best-effort */
    }
  }
  return ig;
}

function isIgnoredPath(rel: string): boolean {
  const parts = rel.split("/");
  for (const p of parts) {
    if (IGNORE_DIRS.has(p)) return true;
  }
  return false;
}

function isParseable(rel: string): boolean {
  // We only re-extract languages we can index. Unparsed files would still
  // get `files` rows in a full index, but for incremental updates we skip
  // them — they don't contribute symbols/edges and the walker re-adds them
  // on the next full re-index if needed.
  return languageOf(rel) !== "unparsed";
}

export interface StartWatcherOptions {
  /** Override debounce window (ms). Test hook. */
  debounceMs?: number;
  /** Hook called after each batch is processed. Test hook. */
  onProcessed?: (paths: string[]) => void;
}

export function startRepoWatcher(
  db: Db,
  repoRoot: string,
  opts: StartWatcherOptions = {},
): RepoWatcher {
  const ig = loadGitignore(repoRoot);
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let inflight: Promise<void> = Promise.resolve();
  let closed = false;
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(
      repoRoot,
      { recursive: true },
      (_event, filename) => {
        if (closed) return;
        if (!filename) return;
        const rel = String(filename).split(sep).join("/");
        if (rel === "" || rel.startsWith("..")) return;
        if (isIgnoredPath(rel)) return;
        // .gitignore matches: walker uses `rel` (no trailing slash) for files.
        if (ig.ignores(rel)) return;
        if (!isParseable(rel)) return;
        pending.add(rel);
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, debounceMs);
        timer.unref?.();
      },
    );
    watcher.on("error", () => {
      // EMFILE / ENOSPC / platform glitches — drop the watcher silently.
      // The daemon falls back to its existing "explicit `index` RPC"
      // behavior. Logging would spam stderr in tests.
    });
  } catch {
    // Recursive watch not available — degrade gracefully.
    watcher = null;
  }

  function flush(): void {
    if (closed) return;
    if (pending.size === 0) return;
    const batch = Array.from(pending);
    pending.clear();
    timer = null;
    inflight = inflight.then(() => processBatch(batch));
  }

  async function processBatch(paths: string[]): Promise<void> {
    for (const rel of paths) {
      const abs = join(repoRoot, rel);
      try {
        if (!existsSync(abs)) {
          removeFile(db, rel);
          continue;
        }
        await reExtractFile(db, repoRoot, rel);
      } catch {
        // Swallow per-file errors; a transient parse failure shouldn't
        // tear down the watcher for the whole repo.
      }
    }
    opts.onProcessed?.(paths);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
    }
  }

  async function flushAsync(): Promise<void> {
    // If a debounce timer is pending, fire it now.
    if (timer) {
      clearTimeout(timer);
      timer = null;
      flush();
    }
    await inflight;
  }

  return { close, flush: flushAsync };
}

void relative;
