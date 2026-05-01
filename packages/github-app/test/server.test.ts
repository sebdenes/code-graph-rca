import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sign } from "@octokit/webhooks-methods";
import { createApp, type AppHandle } from "../src/server.js";
import type { PrCommentApi } from "../src/types.js";

const SECRET = "test-secret-shhh";

function fakeOctokit(): PrCommentApi {
  return {
    issues: {
      listComments: async () => ({ data: [] }),
      createComment: async () => ({ data: { id: 1, body: "" } }),
      updateComment: async () => ({ data: { id: 1, body: "" } }),
    },
    pulls: {
      listFiles: async () => ({ data: [] }),
    },
  };
}

let handle: AppHandle;

beforeAll(async () => {
  handle = createApp({
    appId: 1,
    privateKey: "unused-in-tests",
    webhookSecret: SECRET,
    octokitFactory: async () => fakeOctokit(),
  });
  await handle.fastify.ready();
});

afterAll(async () => {
  if (handle) await handle.close();
});

describe("GET /healthz", () => {
  it("returns ok with no auth", async () => {
    const res = await handle.fastify.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("POST /webhook", () => {
  const payload = {
    zen: "hello",
    hook_id: 1,
  };
  const body = JSON.stringify(payload);

  it("rejects bad signature with 401", async () => {
    const res = await handle.fastify.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "11111111-1111-1111-1111-111111111111",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a properly signed ping", async () => {
    const signature = await sign(SECRET, body);
    const res = await handle.fastify.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "22222222-2222-2222-2222-222222222222",
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 when required headers are missing", async () => {
    const res = await handle.fastify.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });
});
