/**
 * Unit tests for the MCP bridge client. We override `os.homedir` via the
 * HOME / USERPROFILE env vars so `discoverBridge` reads from a tmp dir.
 *
 * The round-trip test stands up a plain Node http server that mimics the
 * `/api/bridge/select` POST/GET contract — no extra deps needed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import { discoverBridge, BridgeClient } from "../../src/mcp/bridge.js";

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "cgrca-bridge-test-"));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("discoverBridge", () => {
  it("returns null when ~/.cgrca/bridge.json is missing", () => {
    expect(discoverBridge()).toBeNull();
  });

  it("returns the URL when the file exists", () => {
    mkdirSync(join(tmpHome, ".cgrca"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".cgrca", "bridge.json"),
      JSON.stringify({ url: "http://127.0.0.1:7331", port: 7331, pid: 99 }),
    );
    const lock = discoverBridge();
    expect(lock).not.toBeNull();
    expect(lock?.url).toBe("http://127.0.0.1:7331");
    expect(lock?.port).toBe(7331);
  });
});

describe("BridgeClient round-trip", () => {
  let server: Server;
  let url: string;
  let stored: { name: string; file: string; line: number } | null = null;

  beforeEach(async () => {
    stored = null;
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== "/api/bridge/select") {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
              | { name: string; file: string; line: number }
              | null;
            stored = body ?? null;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.statusCode = 400;
            res.end();
          }
        });
        return;
      }
      if (req.method === "GET") {
        res.setHeader("content-type", "application/json");
        if (stored === null) res.end(JSON.stringify({ none: true }));
        else res.end(JSON.stringify(stored));
        return;
      }
      res.statusCode = 405;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("postSelection then getSelection returns the same payload", async () => {
    const client = new BridgeClient({ url });
    const ok = await client.postSelection({ name: "victim", file: "a.ts", line: 5 });
    expect(ok).toBe(true);
    const got = await client.getSelection();
    expect(got).not.toBeNull();
    expect(got?.name).toBe("victim");
    expect(got?.file).toBe("a.ts");
    expect(got?.line).toBe(5);
  });
});
