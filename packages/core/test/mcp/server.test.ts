/**
 * End-to-end MCP server smoke test.
 *
 * Spawns the cgrca CLI in `mcp` mode against the py-package fixture, then
 * speaks JSON-RPC over stdio: initialize → tools/list → call cgrca_definitionOf.
 * Validates the contract any MCP client (Cursor, Claude Code, etc.) will see.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const PY_FIXTURE = join(REPO, "test", "fixtures", "py-package");
const CLI = join(REPO, "src", "cli.ts");

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class StdioClient {
  private buf = "";
  private pending = new Map<number, (msg: JsonRpcMessage) => void>();
  private nextId = 1;
  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
  }
  private onData(chunk: string): void {
    this.buf += chunk;
    // MCP stdio frames are newline-delimited JSON.
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.trim().length === 0) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (typeof msg.id === "number") {
          const cb = this.pending.get(msg.id);
          if (cb) {
            this.pending.delete(msg.id);
            cb(msg);
          }
        }
      } catch {
        // Not JSON — ignore (server might log to stderr accidentally).
      }
    }
  }
  request(method: string, params?: unknown, timeoutMs = 20_000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const frame: JsonRpcMessage = { jsonrpc: "2.0", id, method };
    if (params !== undefined) frame.params = params;
    const json = JSON.stringify(frame) + "\n";
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(json);
    });
  }
  notify(method: string, params?: unknown): void {
    const frame: JsonRpcMessage = { jsonrpc: "2.0", method };
    if (params !== undefined) frame.params = params;
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }
  close(): void {
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      // best-effort
    }
  }
}

describe("mcp server: stdio round-trip", () => {
  it("initialize → tools/list → call cgrca_definitionOf returns the right symbol", async () => {
    const child = spawn("npx", ["tsx", CLI, "mcp", PY_FIXTURE], {
      cwd: REPO,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new StdioClient(child);
    try {
      const init = await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "cgrca-test", version: "0.0.0" },
      });
      expect(init.error).toBeUndefined();
      expect(init.result).toBeDefined();
      // The post-init notification kicks the server out of "initializing" mode.
      client.notify("notifications/initialized");

      const list = await client.request("tools/list");
      expect(list.error).toBeUndefined();
      const tools = (list.result as { tools: Array<{ name: string }> }).tools;
      const names = new Set(tools.map((t) => t.name));
      expect(names).toContain("cgrca_definitionOf");
      expect(names).toContain("cgrca_callersOf");
      expect(names).toContain("cgrca_calleesOf");
      expect(names).toContain("cgrca_symbolsInFile");
      expect(names).toContain("cgrca_recentlyChangedNear");
      expect(names).toContain("cgrca_rca");
      expect(names).toContain("cgrca_rcaPrompt");
      expect(names).toContain("cgrca_scope");

      const callRes = await client.request("tools/call", {
        name: "cgrca_definitionOf",
        arguments: { name: "ingest" },
      });
      expect(callRes.error).toBeUndefined();
      const result = callRes.result as {
        content: Array<{ type: string; text: string }>;
      };
      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0]!.text) as Array<{
        name: string;
        kind: string;
        file: string;
      }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.name).toBe("ingest");
      expect(parsed[0]!.kind).toBe("function");
      expect(parsed[0]!.file).toContain("ingest.py");
    } finally {
      client.close();
    }
  }, 60_000);
});

/**
 * Race regression test.
 *
 * Before the fix, two concurrent `ensureIndex` calls for the same repoRoot
 * each invoked `indexScope` and the second `db.close()`-ed the first
 * mid-flight ("Db is closed" / silent corruption). After the fix,
 * concurrent callers must share a single in-flight promise and
 * `indexScope` must run exactly once per repoRoot.
 */
describe("mcp server: indexScope singleton race", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../src/graph/orchestrator.js");
  });

  it("two concurrent ensureIndex calls for the same repo invoke indexScope exactly once", async () => {
    let calls = 0;
    let resolveIndex: ((v: unknown) => void) | null = null;
    const indexPromise = new Promise((res) => {
      resolveIndex = res;
    });

    vi.doMock("../../src/graph/orchestrator.js", () => ({
      indexScope: vi.fn(async () => {
        calls += 1;
        await indexPromise;
        return {
          // A close-able stub is enough — _resetCache will call .close().
          db: { close: () => {} } as unknown,
          fileCount: 0,
          symbolCount: 1,
          edgeCount: 2,
          importCount: 0,
          unparsedCount: 0,
        };
      }),
    }));

    const mod = await import("../../src/mcp/server.js");
    await mod._resetCache();

    // Fire concurrently — both must observe the same in-flight promise.
    const a = mod._ensureIndex("/tmp/repo-A");
    const b = mod._ensureIndex("/tmp/repo-A");

    // Let both calls reach the cache check before indexScope settles.
    await new Promise((r) => setImmediate(r));
    resolveIndex!(undefined);

    const [ha, hb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(ha).toBe(hb); // same handle — same DB, no double-indexing
    expect(ha.symbolCount).toBe(1);

    await mod._resetCache();
  }, 10_000);

  it("different repoRoots get independent entries; old entry is closed after settle", async () => {
    const closes: string[] = [];
    let calls = 0;

    vi.doMock("../../src/graph/orchestrator.js", () => ({
      indexScope: vi.fn(async (opts: { repoRoot: string }) => {
        calls += 1;
        return {
          db: { close: () => closes.push(opts.repoRoot) } as unknown,
          fileCount: 0,
          symbolCount: 0,
          edgeCount: 0,
          importCount: 0,
          unparsedCount: 0,
        };
      }),
    }));

    const mod = await import("../../src/mcp/server.js");
    await mod._resetCache();

    await mod._ensureIndex("/tmp/repo-A");
    await mod._ensureIndex("/tmp/repo-B");
    // Give the deferred close() microtask a chance to run.
    await new Promise((r) => setImmediate(r));

    expect(calls).toBe(2);
    expect(closes).toEqual(["/tmp/repo-A"]); // old repo's DB closed after settle

    await mod._resetCache();
  }, 10_000);
});
