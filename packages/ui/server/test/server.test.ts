import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { createServer, type ServerHandle } from "../src/index.js";
import { makeFixtureRepo, persistRca } from "./helpers.js";
import type {
  BlameResponse,
  DiffResponse,
  ImpactResponse,
  QueryResponse,
  RcaSnapshot,
  SessionsResponse,
  SourceResponse,
} from "../../shared/api.js";

let handle: ServerHandle;
let sessionId: string;
let repoRoot: string;
let sha: string;

beforeAll(async () => {
  const fix = makeFixtureRepo();
  repoRoot = fix.root;
  sha = fix.initialSha;
  await persistRca(fix.root, fix.sqlite);
  // Point the server at the directory holding the .sqlite.
  handle = await createServer({ path: dirname(fix.sqlite), dev: true });
  await handle.fastify.ready();
  const list = Array.from(handle.sessions.values());
  expect(list.length).toBeGreaterThan(0);
  const first = list[0];
  if (!first) throw new Error("no session");
  sessionId = first.summary.id;
});

afterAll(async () => {
  if (handle) await handle.close();
});

describe("GET /api/sessions", () => {
  it("returns session list with counts", async () => {
    const res = await handle.fastify.inject({
      method: "GET",
      url: "/api/sessions",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SessionsResponse;
    expect(body.sessions.length).toBeGreaterThan(0);
    const s = body.sessions[0];
    if (!s) throw new Error("no session in response");
    expect(s.symbolCount).toBeGreaterThan(0);
    expect(s.fileCount).toBeGreaterThan(0);
    expect(s.repoRoot).toBe(repoRoot);
    expect(s.rcaAvailable).toBe(true);
    expect(s.primarySymbol).toBe("victim");
  });
});

describe("GET /api/session/:id/rca", () => {
  it("returns the persisted RcaSnapshot", async () => {
    const res = await handle.fastify.inject({
      method: "GET",
      url: `/api/session/${sessionId}/rca`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as RcaSnapshot;
    expect(body.primarySymbol).toBe("victim");
    expect(typeof body.prompt).toBe("string");
    expect(body.prompt.length).toBeGreaterThan(0);
  });

  it("404s for unknown session id", async () => {
    const res = await handle.fastify.inject({
      method: "GET",
      url: `/api/session/nope/rca`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/session/:id/query", () => {
  it("definitionOf returns the right symbol", async () => {
    const res = await handle.fastify.inject({
      method: "POST",
      url: `/api/session/${sessionId}/query`,
      payload: { name: "definitionOf", args: { name: "victim" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as QueryResponse;
    expect(body.name).toBe("definitionOf");
    if (body.name !== "definitionOf") throw new Error("wrong shape");
    expect(body.result.length).toBeGreaterThan(0);
    const first = body.result[0];
    if (!first) throw new Error("no def");
    expect(first.name).toBe("victim");
    expect(first.file).toBe("a.ts");
  });
});

describe("GET /api/session/:id/source/*", () => {
  it("returns content + correct language", async () => {
    const res = await handle.fastify.inject({
      method: "GET",
      url: `/api/session/${sessionId}/source/a.ts`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SourceResponse;
    expect(body.language).toBe("typescript");
    expect(body.content).toContain("victim");
    expect(body.loc).toBeGreaterThan(0);
  });

  it("rejects path traversal with 400 via real HTTP", async () => {
    // fastify-inject normalizes `..` away in the URL parser, so use a real
    // listen+http.request to send the raw, un-normalized path.
    await handle.fastify.listen({ port: 0, host: "127.0.0.1" });
    const addr = handle.fastify.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const port = addr.port;
    const status = await new Promise<number>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const http = require("node:http") as typeof import("node:http");
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "GET",
          // Skip Node's URL parser by writing the request line directly.
          path: `/api/session/${sessionId}/source/..%2F..%2F..%2Fetc%2Fpasswd`,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
  });
});

import { resolveSandboxed } from "../src/routes/source.js";

describe("resolveSandboxed", () => {
  it("rejects parent-traversal", () => {
    expect(resolveSandboxed("/tmp/repo", "../etc/passwd")).toBeNull();
    expect(resolveSandboxed("/tmp/repo", "a/../../b")).toBeNull();
  });
  it("rejects absolute paths", () => {
    expect(resolveSandboxed("/tmp/repo", "/etc/passwd")).toBeNull();
  });
  it("accepts nested relative paths", () => {
    expect(resolveSandboxed("/tmp/repo", "src/a.ts")).toBe("/tmp/repo/src/a.ts");
  });
});

describe("GET /api/session/:id/blame/*", () => {
  it("returns blame lines on a tracked file", async () => {
    const res = await handle.fastify.inject({
      method: "GET",
      url: `/api/session/${sessionId}/blame/a.ts`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BlameResponse;
    expect(body.path).toBe("a.ts");
    expect(body.lines.length).toBeGreaterThan(0);
    const first = body.lines[0];
    if (!first) throw new Error("no blame line");
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(first.author).toBe("Tester");
  });

  it("returns empty lines for an untracked file", async () => {
    const res = await handle.fastify.inject({
      method: "GET",
      url: `/api/session/${sessionId}/blame/does-not-exist.ts`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BlameResponse;
    expect(body.lines).toEqual([]);
  });
});

describe("POST /api/session/:id/impact", () => {
  it("returns a tree with at least one caller and riskScore >= 0", async () => {
    const res = await handle.fastify.inject({
      method: "POST",
      url: `/api/session/${sessionId}/impact`,
      payload: { symbolName: "victim", depth: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ImpactResponse;
    expect(body.seed.name).toBe("victim");
    expect(body.tree.callers.length).toBeGreaterThan(0);
    expect(body.maxRisk).toBeGreaterThanOrEqual(0);
    for (const n of body.nodes) {
      expect(n.riskScore).toBeGreaterThanOrEqual(0);
      expect(n.riskScore).toBeLessThanOrEqual(1);
    }
    // nodes are sorted desc by riskScore.
    for (let i = 1; i < body.nodes.length; i++) {
      const prev = body.nodes[i - 1];
      const cur = body.nodes[i];
      if (prev && cur) expect(prev.riskScore).toBeGreaterThanOrEqual(cur.riskScore);
    }
    // Test coverage detection should pick up tests/victim_test.ts on the seed.
    expect(body.tree.testCoverage.length).toBeGreaterThan(0);
  });
});

describe("GET /api/session/:id/diff/:sha", () => {
  it("returns the parsed commit info", async () => {
    const res = await handle.fastify.inject({
      method: "GET",
      url: `/api/session/${sessionId}/diff/${sha}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DiffResponse;
    expect(body.commit).toBe(sha);
    expect(body.author).toBe("Tester");
    expect(body.subject).toBe("initial");
    expect(body.files.length).toBeGreaterThan(0);
    const a = body.files.find((f) => f.path === "a.ts");
    expect(a).toBeDefined();
    if (a) {
      expect(a.additions).toBeGreaterThan(0);
      expect(a.patch).toContain("a.ts");
    }
  });

  it("rejects non-hex sha with 400", async () => {
    const res = await handle.fastify.inject({
      method: "GET",
      url: `/api/session/${sessionId}/diff/not-a-sha--rm-rf`,
    });
    expect(res.statusCode).toBe(400);
  });
});
