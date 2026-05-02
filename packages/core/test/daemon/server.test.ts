import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
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
