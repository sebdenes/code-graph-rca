import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import type { Db } from "../graph/db.js";
import { indexScope } from "../graph/orchestrator.js";
import {
  callersOf,
  calleesOf,
  definitionOf,
  recentlyChangedNear,
} from "../graph/queries.js";
import { runRca, type FailureScope } from "../rca/runner.js";
import {
  decodeFrames,
  encodeFrame,
  ErrorCodes,
  JSONRPC_VERSION,
  type RpcRequest,
} from "./protocol.js";
import {
  ensureRoot,
  repoDbPath,
  SOCKET_PATH,
} from "./state.js";
import { acquireLock, releaseLock } from "./lockfile.js";
import { startRepoWatcher, type RepoWatcher } from "./watcher.js";

/**
 * cgrcad: long-lived JSON-RPC server over a unix domain socket.
 *
 * Owns one sqlite handle per repo (lazily opened on first call). Idle
 * timeout closes the daemon after 1h of inactivity. The CLI subcommand
 * `cgrca daemon start` forks this and detaches.
 */

export interface DaemonOptions {
  socketPath?: string;
  /** Idle timeout in ms; default 1h. */
  idleTimeoutMs?: number;
  /** If true, take the lockfile. Tests that run in-process pass false. */
  takeLock?: boolean;
}

export interface DaemonHandle {
  /** Stops the daemon: closes server, sqlite handles, releases lock. */
  stop: () => Promise<void>;
  /** Resolves once the daemon is listening. */
  ready: Promise<void>;
  /** Repo registry — exposed for tests. */
  repos: Map<string, Db>;
  /** Per-repo fs watchers — exposed for tests (flush()). */
  watchers: Map<string, RepoWatcher>;
}

const DEFAULT_IDLE_MS = 60 * 60 * 1000;

export function startDaemon(opts: DaemonOptions = {}): DaemonHandle {
  ensureRoot();
  const socketPath = opts.socketPath ?? SOCKET_PATH;
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const takeLock = opts.takeLock !== false;

  if (takeLock && !acquireLock()) {
    throw new Error("cgrcad: another daemon already holds the lockfile");
  }

  // Stale socket file from a previous crashed run — remove before bind.
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* harmless */ }
  }

  const repos = new Map<string, Db>();
  const watchers = new Map<string, RepoWatcher>();
  const startedAt = Date.now();
  let lastActivity = Date.now();
  let inflight = 0;
  let stopping = false;

  const server: Server = createServer((sock) => onConnection(sock));

  function bumpIdle(): void {
    lastActivity = Date.now();
  }

  // Idle-timeout poller. Cheap (1s tick) and deterministic in tests.
  const idleTimer = setInterval(() => {
    if (stopping) return;
    if (inflight > 0) return;
    if (Date.now() - lastActivity >= idleMs) {
      void stop();
    }
  }, 1_000);
  // Don't keep the event loop alive just for the idle check.
  idleTimer.unref();

  function getDb(repoRoot: string): Promise<Db> {
    const key = resolve(repoRoot);
    const cached = repos.get(key);
    if (cached) return Promise.resolve(cached);
    const persist = repoDbPath(key);
    return indexScope({ repoRoot: key, persist }).then((r) => {
      repos.set(key, r.db);
      // Start the fs watcher on first bootstrap. Subsequent `index` RPCs
      // reuse the same watcher — no need to tear it down on a full
      // re-index since the watcher only reads/writes via the live `Db`
      // handle, which we keep stable below.
      if (!watchers.has(key)) {
        watchers.set(key, startRepoWatcher(r.db, key));
      }
      return r.db;
    });
  }

  async function dispatch(req: RpcRequest): Promise<unknown> {
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case "ping":
        return { pong: true, uptimeMs: Date.now() - startedAt };
      case "status":
        return {
          pid: process.pid,
          startedAt,
          repos: Array.from(repos.keys()),
        };
      case "stop":
        // Schedule the shutdown after we flush this response.
        setImmediate(() => { void stop(); });
        return { stopping: true };
      case "index": {
        const repoRoot = String(params.repoRoot ?? "");
        if (!repoRoot) throw rpcErr(ErrorCodes.InvalidParams, "missing repoRoot");
        const key = resolve(repoRoot);
        const persist = repoDbPath(key);
        // Tear down the watcher *before* the rewrite — its in-flight
        // re-extracts hold the old Db handle. After the rewrite below the
        // handle is stale.
        const oldWatcher = watchers.get(key);
        if (oldWatcher) { try { oldWatcher.close(); } catch { /* ignore */ } watchers.delete(key); }
        const r = await indexScope({ repoRoot: key, persist });
        // Replace any cached handle (the old one is stale post-rewrite).
        const old = repos.get(key);
        if (old && old !== r.db) { try { old.close(); } catch { /* ignore */ } }
        repos.set(key, r.db);
        watchers.set(key, startRepoWatcher(r.db, key));
        return {
          fileCount: r.fileCount,
          symbolCount: r.symbolCount,
          edgeCount: r.edgeCount,
          importCount: r.importCount,
          unparsedCount: r.unparsedCount,
        };
      }
      case "define": {
        const db = await getDb(String(params.repoRoot ?? ""));
        return definitionOf(db, String(params.name ?? ""));
      }
      case "callers": {
        const db = await getDb(String(params.repoRoot ?? ""));
        const depth = typeof params.depth === "number" ? params.depth : 2;
        const queryOpts: { depth: number; minConfidence?: number } = { depth };
        if (typeof params.minConfidence === "number") {
          queryOpts.minConfidence = params.minConfidence;
        }
        return callersOf(db, String(params.name ?? ""), queryOpts);
      }
      case "callees": {
        const db = await getDb(String(params.repoRoot ?? ""));
        const depth = typeof params.depth === "number" ? params.depth : 1;
        return calleesOf(db, String(params.name ?? ""), { depth });
      }
      case "changed": {
        const repoRoot = resolve(String(params.repoRoot ?? ""));
        const db = await getDb(repoRoot);
        const sinceDays = typeof params.sinceDays === "number" ? params.sinceDays : 90;
        const maxCommits = typeof params.maxCommits === "number" ? params.maxCommits : 50;
        return recentlyChangedNear(db, String(params.name ?? ""), {
          repoRoot,
          sinceDays,
          maxCommits,
        });
      }
      case "rca": {
        const repoRoot = resolve(String(params.repoRoot ?? ""));
        const failure = params.failure as FailureScope;
        const budget = params.budget as
          | { maxFiles?: number; maxLoc?: number; maxDepth?: number }
          | undefined;
        return runRca({
          repoRoot,
          failureScope: failure,
          ...(budget ? { budget } : {}),
          persist: repoDbPath(repoRoot),
        });
      }
      default:
        throw rpcErr(ErrorCodes.MethodNotFound, `method not found: ${req.method}`);
    }
  }

  function onConnection(sock: Socket): void {
    let buf: Buffer = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer) => {
      bumpIdle();
      buf = Buffer.concat([buf, chunk]) as Buffer;
      const { frames, rest } = decodeFrames(buf);
      buf = rest as Buffer;
      for (const f of frames) {
        void handleFrame(sock, f);
      }
    });
    sock.on("error", () => { /* client gone — nothing to do */ });
  }

  async function handleFrame(sock: Socket, frame: unknown): Promise<void> {
    const req = frame as RpcRequest;
    if (
      !req ||
      typeof req !== "object" ||
      (req as { __parseError?: boolean }).__parseError ||
      req.jsonrpc !== JSONRPC_VERSION ||
      typeof req.method !== "string"
    ) {
      try {
        sock.write(
          encodeFrame({
            jsonrpc: JSONRPC_VERSION,
            id: (req && (req as RpcRequest).id) ?? null,
            error: { code: ErrorCodes.InvalidRequest, message: "invalid request" },
          }),
        );
      } catch { /* socket gone */ }
      return;
    }
    inflight++;
    try {
      const result = await dispatch(req);
      try {
        sock.write(encodeFrame({ jsonrpc: JSONRPC_VERSION, id: req.id, result }));
      } catch { /* client disconnected mid-call */ }
    } catch (err) {
      const e = err as { code?: number; message?: string };
      try {
        sock.write(
          encodeFrame({
            jsonrpc: JSONRPC_VERSION,
            id: req.id,
            error: {
              code: typeof e.code === "number" ? e.code : ErrorCodes.InternalError,
              message: e.message ?? String(err),
            },
          }),
        );
      } catch { /* client disconnected mid-call */ }
    } finally {
      inflight--;
      bumpIdle();
    }
  }

  let stopResolve: (() => void) | undefined;
  const stopped = new Promise<void>((r) => { stopResolve = r; });

  async function stop(): Promise<void> {
    if (stopping) { await stopped; return; }
    stopping = true;
    clearInterval(idleTimer);
    await new Promise<void>((r) => server.close(() => r()));
    for (const w of watchers.values()) {
      try { w.close(); } catch { /* ignore */ }
    }
    watchers.clear();
    for (const db of repos.values()) {
      try { db.close(); } catch { /* ignore */ }
    }
    repos.clear();
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch { /* harmless */ }
    }
    if (takeLock) releaseLock();
    stopResolve?.();
  }

  const ready = new Promise<void>((r, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      // 0600 — UDS perms are the only auth gate.
      try { chmodSync(socketPath, 0o600); } catch { /* not fatal on some FS */ }
      r();
    });
  });

  return { stop, ready, repos, watchers };
}

function rpcErr(code: number, message: string): Error & { code: number } {
  const e = new Error(message) as Error & { code: number };
  e.code = code;
  return e;
}
