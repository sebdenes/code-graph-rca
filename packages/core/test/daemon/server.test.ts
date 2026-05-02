import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync, openSync, closeSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  callDaemon,
  ensureRoot,
  isDaemonUp,
  isLiveLock,
  LOCK_PATH,
  releaseLock,
  startDaemon,
} from "../../src/daemon/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..");
const TS_FIXTURE = join(REPO_ROOT, "fixtures", "ts-monorepo");

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try { await fn(); } catch { /* best effort */ }
  }
});

function tmpSocketPath(): string {
  // Unix socket paths max out at ~104 chars on macOS, so keep it short.
  const dir = mkdtempSync(join(tmpdir(), "cgrcad-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "d.sock");
}

describe("cgrcad server", () => {
  it("starts, answers ping, and stops cleanly", async () => {
    const sock = tmpSocketPath();
    const handle = startDaemon({ socketPath: sock, takeLock: false });
    cleanups.push(() => handle.stop());
    await handle.ready;

    expect(await isDaemonUp(sock)).toBe(true);
    const pong = await callDaemon<{ pong: boolean }>("ping", {}, { socketPath: sock });
    expect(pong.pong).toBe(true);

    await handle.stop();
    expect(await isDaemonUp(sock)).toBe(false);
  });

  it("answers `define` and warm calls are <50ms", async () => {
    const sock = tmpSocketPath();
    const handle = startDaemon({ socketPath: sock, takeLock: false });
    cleanups.push(() => handle.stop());
    await handle.ready;

    // First call indexes the repo (cold). Second call must be fast.
    await callDaemon("define", { repoRoot: TS_FIXTURE, name: "login" }, { socketPath: sock, timeoutMs: 30_000 });
    const t0 = Date.now();
    const defs = await callDaemon<Array<{ name: string }>>(
      "define",
      { repoRoot: TS_FIXTURE, name: "login" },
      { socketPath: sock, timeoutMs: 5_000 },
    );
    const ms = Date.now() - t0;
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0]!.name).toBe("login");
    expect(ms).toBeLessThan(50);
  });

  it("reclaims a stale lockfile (PID not alive)", () => {
    // Seed a lockfile with a guaranteed-dead PID. PID 1 is init on Unix
    // and we *don't* want to use it. Pick something past max_pid (2^22)
    // by writing with O_CREAT and unlinking via the helper.
    ensureRoot();
    // First clear any real lock from a parallel test/dev daemon.
    try { releaseLock(); } catch { /* ignore */ }

    const fd = openSync(LOCK_PATH, "w");
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: 999_999_999, startedAt: Date.now() }));
    closeSync(fd);

    expect(isLiveLock()).toBe(false);
    // acquireLock should reclaim and return true.
    expect(acquireLock()).toBe(true);
    cleanups.push(() => releaseLock());
    expect(isLiveLock()).toBe(true);
  });

  it("fs-watcher picks up new, modified, and deleted files without explicit re-index", async () => {
    const sock = tmpSocketPath();
    // Build a tiny throwaway repo so we can mutate it freely. realpath
    // through /var → /private/var on macOS so the daemon's `repos` key
    // matches the path the test passes to RPCs.
    const repoRaw = mkdtempSync(join(tmpdir(), "cgrcad-fixture-"));
    cleanups.push(() => rmSync(repoRaw, { recursive: true, force: true }));
    const repo = realpathSync(repoRaw);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "seed.ts"),
      "export function seed() { return 1; }\n",
    );

    const handle = startDaemon({ socketPath: sock, takeLock: false });
    cleanups.push(() => handle.stop());
    await handle.ready;

    // Bootstrap the repo (this also starts the watcher).
    await callDaemon(
      "define",
      { repoRoot: repo, name: "seed" },
      { socketPath: sock, timeoutMs: 30_000 },
    );
    const watcher = handle.watchers.get(repo);
    expect(watcher).toBeDefined();

    // 1. New file is picked up.
    writeFileSync(
      join(repo, "src", "added.ts"),
      "export function newThing() { return 42; }\n",
    );
    // Wait a tick longer than the default 150ms debounce, then flush.
    await new Promise((r) => setTimeout(r, 200));
    await watcher!.flush();
    const newDefs = await callDaemon<Array<{ name: string }>>(
      "define",
      { repoRoot: repo, name: "newThing" },
      { socketPath: sock, timeoutMs: 5_000 },
    );
    expect(newDefs.length).toBeGreaterThan(0);
    expect(newDefs[0]!.name).toBe("newThing");

    // 2. Modifying an existing file surfaces the new symbol.
    writeFileSync(
      join(repo, "src", "seed.ts"),
      "export function seed() { return 1; }\nexport function laterAdded() { return 2; }\n",
    );
    await new Promise((r) => setTimeout(r, 200));
    await watcher!.flush();
    const laterDefs = await callDaemon<Array<{ name: string }>>(
      "define",
      { repoRoot: repo, name: "laterAdded" },
      { socketPath: sock, timeoutMs: 5_000 },
    );
    expect(laterDefs.length).toBeGreaterThan(0);

    // 3. Deleting a file drops its symbols.
    unlinkSync(join(repo, "src", "added.ts"));
    await new Promise((r) => setTimeout(r, 200));
    await watcher!.flush();
    const goneDefs = await callDaemon<Array<{ name: string }>>(
      "define",
      { repoRoot: repo, name: "newThing" },
      { socketPath: sock, timeoutMs: 5_000 },
    );
    expect(goneDefs.length).toBe(0);
  });

  it("`callers` RPC honors minConfidence", async () => {
    const sock = tmpSocketPath();
    const handle = startDaemon({ socketPath: sock, takeLock: false });
    cleanups.push(() => handle.stop());
    await handle.ready;

    // Baseline: default minConfidence (0.5) should return some callers.
    const baseline = await callDaemon<{ callers: unknown[] }>(
      "callers",
      { repoRoot: TS_FIXTURE, name: "login" },
      { socketPath: sock, timeoutMs: 30_000 },
    );
    // High-confidence filter (0.9) returns at most as many callers as the
    // baseline — typically strictly fewer once any heuristic edges drop out.
    const filtered = await callDaemon<{ callers: unknown[] }>(
      "callers",
      { repoRoot: TS_FIXTURE, name: "login", minConfidence: 0.9 },
      { socketPath: sock, timeoutMs: 5_000 },
    );
    expect(filtered.callers.length).toBeLessThanOrEqual(baseline.callers.length);
  });

  it("`changed` RPC honors maxCommits", async () => {
    const sock = tmpSocketPath();
    const handle = startDaemon({ socketPath: sock, takeLock: false });
    cleanups.push(() => handle.stop());
    await handle.ready;

    const capped = await callDaemon<unknown[]>(
      "changed",
      { repoRoot: TS_FIXTURE, name: "login", sinceDays: 3650, maxCommits: 5 },
      { socketPath: sock, timeoutMs: 30_000 },
    );
    expect(Array.isArray(capped)).toBe(true);
    expect(capped.length).toBeLessThanOrEqual(5);
  });

  it("idle timeout fires and stops the daemon", async () => {
    const sock = tmpSocketPath();
    const handle = startDaemon({
      socketPath: sock,
      takeLock: false,
      // 50ms — the idle poller ticks every 1s, so we wait up to ~1.5s.
      idleTimeoutMs: 50,
    });
    cleanups.push(() => handle.stop());
    await handle.ready;
    expect(await isDaemonUp(sock)).toBe(true);

    // Wait for the next idle poll to fire.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (!(await isDaemonUp(sock))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await isDaemonUp(sock)).toBe(false);
  });
});
