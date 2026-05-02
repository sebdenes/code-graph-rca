import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { CausalCandidate, RcaResult } from "code-graph-rca";
import { createApp, type AppHandle } from "../src/server.js";
import type { IncidentIssueApi } from "../src/types.js";
import { incidentMarker } from "../src/incident-issue.js";

const SENTRY_SECRET = "sentry-test-secret";
const BEARER = "bearer-test-token";

interface IssueRow {
  number: number;
  title: string;
  body: string;
}

interface IssueCalls {
  list: number;
  create: number;
  update: number;
  lastCreate?: { title: string; body: string; labels?: string[] };
  lastUpdate?: { issue_number: number; title?: string; body?: string };
}

function makeFakeOctokit(state: { issues: IssueRow[]; calls: IssueCalls }): IncidentIssueApi {
  let nextNum = 7000;
  return {
    issues: {
      listForRepo: async () => {
        state.calls.list += 1;
        return { data: state.issues.map((i) => ({ ...i })) };
      },
      create: async (args) => {
        state.calls.create += 1;
        const num = nextNum++;
        const labels = args.labels ?? [];
        state.calls.lastCreate = { title: args.title, body: args.body, labels };
        state.issues.push({ number: num, title: args.title, body: args.body });
        return { data: { number: num, html_url: `https://github.com/${args.owner}/${args.repo}/issues/${num}` } };
      },
      update: async (args) => {
        state.calls.update += 1;
        state.calls.lastUpdate = {
          issue_number: args.issue_number,
          ...(args.title ? { title: args.title } : {}),
          ...(args.body ? { body: args.body } : {}),
        };
        const row = state.issues.find((r) => r.number === args.issue_number);
        if (row) {
          if (args.title) row.title = args.title;
          if (args.body) row.body = args.body;
        }
        return { data: { number: args.issue_number } };
      },
    },
  };
}

/** A canned RcaResult that doesn't need a real repo. */
function fakeRunRca(candidates: CausalCandidate[]): (req: unknown) => Promise<RcaResult> {
  return async () => ({
    graphContext: "## Graph context\n\nfake\n",
    scope: { files: ["src/api.ts"], symbolCount: 3, edgeCount: 2 },
    queries: [],
    primarySymbol: "handleLogin",
    prompt: "",
    notes: [],
    causalCandidates: candidates,
    firstHypothesis: candidates[0]?.rationale ?? null,
  });
}

const SAMPLE_CANDIDATES: CausalCandidate[] = [
  {
    name: "handleLogin",
    file: "src/api/login.ts",
    line: 42,
    score: 0.81,
    rationale: "recent change touched verifyPassword on the same code path",
    unresolvedCallTargets: [],
    recentChanges: [],
  },
  {
    name: "verifyPassword",
    file: "src/api/login.ts",
    line: 8,
    score: 0.55,
    rationale: "transitive callee of handleLogin",
    unresolvedCallTargets: [],
    recentChanges: [],
  },
];

const SENTRY_BODY = {
  data: {
    issue: { id: "SENTRY-9999", title: "TypeError: undefined is not a function" },
    event: {
      event_id: "abc123",
      title: "TypeError: undefined is not a function",
      exception: {
        values: [
          {
            type: "TypeError",
            value: "undefined is not a function",
            stacktrace: {
              frames: [
                { filename: "src/api/login.ts", function: "verifyPassword", lineno: 8 },
                { filename: "src/api/login.ts", function: "handleLogin", lineno: 42 },
              ],
            },
          },
        ],
      },
    },
  },
};

const SENTRY_BODY_RAW = JSON.stringify(SENTRY_BODY);

function sentrySignature(body: string): string {
  return createHmac("sha256", SENTRY_SECRET).update(body, "utf8").digest("hex");
}

let handle: AppHandle;
let octokitState: { issues: IssueRow[]; calls: IssueCalls };

beforeEach(async () => {
  octokitState = {
    issues: [],
    calls: { list: 0, create: 0, update: 0 },
  };
  const fakeOctokit = makeFakeOctokit(octokitState);
  handle = createApp({
    appId: 1,
    privateKey: "unused",
    webhookSecret: "wh-secret",
    octokitFactory: async () => ({
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async () => ({ data: { id: 1 } }),
        updateComment: async () => ({ data: { id: 1 } }),
      },
      pulls: { listFiles: async () => ({ data: [] }) },
    }),
    incident: {
      repoSlug: "octo/widget",
      repoPath: "/tmp/widget-clone",
      sentrySecret: SENTRY_SECRET,
      bearerToken: BEARER,
      octokitFactory: async () => fakeOctokit,
      runRcaOverride: fakeRunRca(SAMPLE_CANDIDATES),
    },
  });
  await handle.fastify.ready();
});

afterEach(async () => {
  if (handle) await handle.close();
});

describe("POST /sentry", () => {
  it("opens a github issue when the signature is valid", async () => {
    const sig = sentrySignature(SENTRY_BODY_RAW);
    const res = await handle.fastify.inject({
      method: "POST",
      url: "/sentry",
      headers: {
        "content-type": "application/json",
        "sentry-hook-signature": sig,
      },
      payload: SENTRY_BODY_RAW,
    });
    expect(res.statusCode).toBe(200);
    expect(octokitState.calls.create).toBe(1);
    expect(octokitState.calls.update).toBe(0);
    const created = octokitState.calls.lastCreate;
    expect(created).toBeDefined();
    expect(created!.title).toContain("SENTRY-9999");
    expect(created!.body).toContain(incidentMarker("SENTRY-9999"));
    expect(created!.body).toContain("handleLogin");
    expect(created!.body).toContain("Ranked candidates");
    expect(created!.labels).toContain("cgrca-incident");
  });

  it("rejects a payload with a bad signature", async () => {
    const res = await handle.fastify.inject({
      method: "POST",
      url: "/sentry",
      headers: {
        "content-type": "application/json",
        "sentry-hook-signature": "deadbeef".repeat(8),
      },
      payload: SENTRY_BODY_RAW,
    });
    expect(res.statusCode).toBe(401);
    expect(octokitState.calls.create).toBe(0);
  });
});

describe("POST /incident", () => {
  it("opens a github issue when given a generic stack trace + bearer", async () => {
    const body = JSON.stringify({
      issueId: "ops-incident-2026-05-02-001",
      title: "API 500s on /v1/login",
      failureText:
        "TypeError: undefined is not a function\n  at handleLogin (src/api/login.ts:42)\n  at verifyPassword (src/api/login.ts:8)",
    });
    const res = await handle.fastify.inject({
      method: "POST",
      url: "/incident",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${BEARER}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(octokitState.calls.create).toBe(1);
    const created = octokitState.calls.lastCreate;
    expect(created!.title).toContain("ops-incident-2026-05-02-001");
    expect(created!.body).toContain("handleLogin");
  });

  it("rejects a generic incident with the wrong bearer", async () => {
    const res = await handle.fastify.inject({
      method: "POST",
      url: "/incident",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
      payload: JSON.stringify({
        issueId: "x",
        failureText: "boom",
      }),
    });
    expect(res.statusCode).toBe(401);
    expect(octokitState.calls.create).toBe(0);
  });
});

describe("idempotency", () => {
  it("re-fires of the same Sentry issue id update the existing github issue", async () => {
    const sig = sentrySignature(SENTRY_BODY_RAW);
    const headers = {
      "content-type": "application/json",
      "sentry-hook-signature": sig,
    };

    const r1 = await handle.fastify.inject({
      method: "POST",
      url: "/sentry",
      headers,
      payload: SENTRY_BODY_RAW,
    });
    expect(r1.statusCode).toBe(200);
    expect(octokitState.calls.create).toBe(1);
    expect(octokitState.calls.update).toBe(0);

    // Re-fire — same body, same id. Should hit issues.update, not issues.create.
    const r2 = await handle.fastify.inject({
      method: "POST",
      url: "/sentry",
      headers,
      payload: SENTRY_BODY_RAW,
    });
    expect(r2.statusCode).toBe(200);
    expect(octokitState.calls.create).toBe(1);
    expect(octokitState.calls.update).toBe(1);
    expect(octokitState.calls.lastUpdate?.body).toContain(incidentMarker("SENTRY-9999"));
  });
});

describe("disabled-by-default", () => {
  it("returns 503 when SENTRY_WEBHOOK_SECRET is not configured", async () => {
    const bare = createApp({
      appId: 1,
      privateKey: "unused",
      webhookSecret: "wh-secret",
      octokitFactory: async () => ({
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async () => ({ data: { id: 1 } }),
          updateComment: async () => ({ data: { id: 1 } }),
        },
        pulls: { listFiles: async () => ({ data: [] }) },
      }),
    });
    await bare.fastify.ready();
    const res = await bare.fastify.inject({
      method: "POST",
      url: "/sentry",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(503);
    await bare.close();
  });
});

describe("rca failure surface", () => {
  it("files an issue with the error rather than dropping the alert", async () => {
    const failHandle = createApp({
      appId: 1,
      privateKey: "unused",
      webhookSecret: "wh-secret",
      octokitFactory: async () => ({
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async () => ({ data: { id: 1 } }),
          updateComment: async () => ({ data: { id: 1 } }),
        },
        pulls: { listFiles: async () => ({ data: [] }) },
      }),
      incident: {
        repoSlug: "octo/widget",
        repoPath: "/tmp/widget-clone",
        sentrySecret: SENTRY_SECRET,
        bearerToken: BEARER,
        octokitFactory: async () => makeFakeOctokit(octokitState),
        runRcaOverride: async () => {
          throw new Error("repo not found at /tmp/widget-clone");
        },
      },
    });
    await failHandle.fastify.ready();
    const sig = sentrySignature(SENTRY_BODY_RAW);
    const res = await failHandle.fastify.inject({
      method: "POST",
      url: "/sentry",
      headers: {
        "content-type": "application/json",
        "sentry-hook-signature": sig,
      },
      payload: SENTRY_BODY_RAW,
    });
    expect(res.statusCode).toBe(200);
    expect(octokitState.calls.create).toBe(1);
    expect(octokitState.calls.lastCreate?.body).toContain("RCA failed");
    expect(octokitState.calls.lastCreate?.body).toContain("repo not found");
    expect(octokitState.calls.lastCreate?.labels).toContain("cgrca-rca-failed");
    await failHandle.close();
  });
});
