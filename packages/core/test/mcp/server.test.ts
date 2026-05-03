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
      expect(names).toContain("cgrca_rcaWithReasoning");
      expect(names).toContain("cgrca_enrichCandidates");
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

/**
 * Daemon-routing tests for the tools wired in week 4 + week 5.
 *
 * Rather than spawn a real daemon, we mock `daemon/client.js` so:
 *   - `isDaemonUp()` returns true
 *   - `callDaemon("status", ...)` reports the repo as indexed
 *   - `callDaemon(<rpc>, ...)` returns a canned payload
 *
 * We capture the tool callbacks via a stub `McpServer` and invoke them
 * directly, asserting which RPC method was called and that the response
 * round-trips through the JSON envelope unchanged.
 */
describe("mcp server: daemon routing", () => {
  const REPO = "/tmp/repo-daemon";
  let calls: Array<{ method: string; params: unknown }>;
  let tools: Map<string, (args: Record<string, unknown>) => Promise<unknown>>;

  beforeEach(() => {
    vi.resetModules();
    calls = [];
    tools = new Map();

    vi.doMock("../../src/daemon/client.js", () => ({
      isDaemonUp: vi.fn(async () => true),
      callDaemon: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "status") return { repos: [REPO] };
        if (method === "changed") {
          return [{ sha: "abc1234", subject: "fix: thing", date: "2026-01-01", author: "a" }];
        }
        if (method === "rca") {
          return {
            failureScope: { kind: "symbol", name: "x" },
            candidates: [{ name: "x", file: "x.ts", score: 0.9 }],
            firstHypothesis: "x changed recently",
            graphContext: {},
            prompt: "## RCA prompt body",
          };
        }
        if (method === "define") return [];
        if (method === "callers" || method === "callees") return { nodes: [], edges: [] };
        return null;
      }),
    }));

    // Stub the SDK so registerTool just stashes the callback we'll invoke.
    vi.doMock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
      McpServer: class {
        registerTool(
          name: string,
          _spec: unknown,
          cb: (args: Record<string, unknown>) => Promise<unknown>,
        ): void {
          tools.set(name, cb);
        }
        connect(): Promise<void> { return Promise.resolve(); }
      },
    }));
    vi.doMock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: class {},
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../src/daemon/client.js");
    vi.doUnmock("@modelcontextprotocol/sdk/server/mcp.js");
    vi.doUnmock("@modelcontextprotocol/sdk/server/stdio.js");
  });

  it("cgrca_callersOf routes to daemon method=callers even when minConfidence is set", async () => {
    const mod = await import("../../src/mcp/server.js");
    await mod._resetCache();
    await mod.startMcpServer({ repoRoot: REPO });
    const cb = tools.get("cgrca_callersOf");
    expect(cb).toBeDefined();

    await cb!({ name: "ingest", depth: 2, minConfidence: 0.9 });
    const rpcCalls = calls.filter((c) => c.method !== "status" && c.method !== "define");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.method).toBe("callers");
    expect(rpcCalls[0]!.params).toMatchObject({
      repoRoot: REPO,
      name: "ingest",
      depth: 2,
      minConfidence: 0.9,
    });
  });

  it("cgrca_recentlyChangedNear routes to daemon method=changed even when maxCommits is set", async () => {
    const mod = await import("../../src/mcp/server.js");
    await mod._resetCache();
    await mod.startMcpServer({ repoRoot: REPO });
    const cb = tools.get("cgrca_recentlyChangedNear");
    expect(cb).toBeDefined();

    await cb!({ name: "ingest", sinceDays: 30, maxCommits: 5 });
    const rpcCalls = calls.filter((c) => c.method !== "status");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.method).toBe("changed");
    expect(rpcCalls[0]!.params).toMatchObject({
      repoRoot: REPO,
      name: "ingest",
      sinceDays: 30,
      maxCommits: 5,
    });
  });

  it("cgrca_recentlyChangedNear routes to daemon method=changed when maxCommits is omitted", async () => {
    const mod = await import("../../src/mcp/server.js");
    await mod._resetCache();
    await mod.startMcpServer({ repoRoot: REPO });
    const cb = tools.get("cgrca_recentlyChangedNear");
    expect(cb).toBeDefined();

    const res = (await cb!({ name: "ingest", sinceDays: 30 })) as {
      content: Array<{ text: string }>;
    };
    const rpcCalls = calls.filter((c) => c.method !== "status");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.method).toBe("changed");
    expect(rpcCalls[0]!.params).toMatchObject({ repoRoot: REPO, name: "ingest", sinceDays: 30 });
    const parsed = JSON.parse(res.content[0]!.text) as Array<{ sha: string }>;
    expect(parsed[0]!.sha).toBe("abc1234");
  });

  it("cgrca_rca routes to daemon method=rca and strips the prompt from JSON payload", async () => {
    const mod = await import("../../src/mcp/server.js");
    await mod._resetCache();
    await mod.startMcpServer({ repoRoot: REPO });
    const cb = tools.get("cgrca_rca");
    expect(cb).toBeDefined();

    const res = (await cb!({ failureKind: "symbol", name: "x" })) as {
      content: Array<{ text: string }>;
    };
    const rpcCalls = calls.filter((c) => c.method !== "status");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.method).toBe("rca");
    expect(rpcCalls[0]!.params).toMatchObject({
      repoRoot: REPO,
      failure: { kind: "symbol", name: "x" },
    });
    const parsed = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(parsed.prompt).toBeUndefined();
    expect(parsed.firstHypothesis).toBe("x changed recently");
  });

  it("cgrca_rcaPrompt routes to daemon method=rca and returns just the prompt text", async () => {
    const mod = await import("../../src/mcp/server.js");
    await mod._resetCache();
    await mod.startMcpServer({ repoRoot: REPO });
    const cb = tools.get("cgrca_rcaPrompt");
    expect(cb).toBeDefined();

    const res = (await cb!({ failureKind: "symbol", name: "x" })) as {
      content: Array<{ text: string }>;
    };
    const rpcCalls = calls.filter((c) => c.method !== "status");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.method).toBe("rca");
    expect(res.content[0]!.text).toBe("## RCA prompt body");
  });
});
