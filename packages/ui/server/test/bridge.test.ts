import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { registerBridgeRoute } from "../src/routes/bridge.js";
import type { LiveEvent } from "../../shared/api.js";

let fastify: FastifyInstance;
let port: number;

beforeEach(async () => {
  fastify = Fastify({ logger: false });
  await fastify.register(websocket);
  registerBridgeRoute(fastify);
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const addr = fastify.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  port = addr.port;
});

afterEach(async () => {
  await fastify.close();
});

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

describe("bridge route", () => {
  it("POST /select then GET /select returns the same payload", async () => {
    const payload = { name: "victim", file: "a.ts", line: 7 };
    const post = await fetch(url("/api/bridge/select"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(post.status).toBe(200);
    const get = await fetch(url("/api/bridge/select"));
    expect(get.status).toBe(200);
    const body = (await get.json()) as { name: string; file: string; line: number };
    expect(body.name).toBe("victim");
    expect(body.file).toBe("a.ts");
    expect(body.line).toBe(7);
  });

  it("WS subscriber receives a kind: 'select' event after a POST", async () => {
    const { default: WS } = await import("ws");
    const ws = new WS(`ws://127.0.0.1:${port}/api/bridge/live`);
    const received = new Promise<LiveEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      ws.on("message", (data: Buffer) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(data.toString()) as LiveEvent);
        } catch (err) {
          reject(err);
        }
      });
      ws.on("error", reject);
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    const payload = { name: "foo", file: "b.ts", line: 12 };
    await fetch(url("/api/bridge/select"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const event = await received;
    expect(event.kind).toBe("select");
    if (event.kind !== "select") throw new Error("wrong kind");
    expect(event.payload).not.toBeNull();
    if (event.payload) {
      expect(event.payload.name).toBe("foo");
      expect(event.payload.file).toBe("b.ts");
      expect(event.payload.line).toBe(12);
    }
    ws.close();
  });

  it("Bridge state cleared on null POST", async () => {
    await fetch(url("/api/bridge/select"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "victim", file: "a.ts", line: 7 }),
    });
    await fetch(url("/api/bridge/select"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(null),
    });
    const get = await fetch(url("/api/bridge/select"));
    const body = (await get.json()) as { none?: boolean };
    expect(body.none).toBe(true);
  });

  it("Two POSTs in succession both land on subscribers", async () => {
    const { default: WS } = await import("ws");
    const ws = new WS(`ws://127.0.0.1:${port}/api/bridge/live`);
    const events: LiveEvent[] = [];
    ws.on("message", (data: Buffer) => {
      try {
        events.push(JSON.parse(data.toString()) as LiveEvent);
      } catch {
        // ignore
      }
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await fetch(url("/api/bridge/select"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a", file: "x.ts", line: 1 }),
    });
    await fetch(url("/api/bridge/select"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "b", file: "y.ts", line: 2 }),
    });
    // Give the WS frames a moment to drain.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const selects = events.filter((e) => e.kind === "select");
    expect(selects.length).toBe(2);
    const first = selects[0];
    const second = selects[1];
    if (first?.kind === "select" && first.payload) {
      expect(first.payload.name).toBe("a");
    }
    if (second?.kind === "select" && second.payload) {
      expect(second.payload.name).toBe("b");
    }
    ws.close();
  });
});
