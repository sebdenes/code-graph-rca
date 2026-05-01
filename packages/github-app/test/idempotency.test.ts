import { describe, expect, it } from "vitest";
import { upsertPrComment } from "../src/idempotency.js";
import { COMMENT_MARKER } from "../src/comment.js";
import type { PrCommentApi } from "../src/types.js";

interface MockState {
  comments: Array<{ id: number; user: { login: string } | null; body: string }>;
  nextId: number;
  calls: { listComments: number; createComment: number; updateComment: number };
}

function makeMockOctokit(state: MockState): PrCommentApi {
  return {
    issues: {
      listComments: async () => {
        state.calls.listComments += 1;
        return { data: state.comments };
      },
      createComment: async (args) => {
        state.calls.createComment += 1;
        const id = state.nextId++;
        state.comments.push({ id, user: { login: "cgrca-bot[bot]" }, body: args.body });
        return { data: { id, body: args.body } };
      },
      updateComment: async (args) => {
        state.calls.updateComment += 1;
        const c = state.comments.find((x) => x.id === args.comment_id);
        if (c) c.body = args.body;
        return { data: { id: args.comment_id, body: args.body } };
      },
    },
    pulls: { listFiles: async () => ({ data: [] }) },
  };
}

describe("upsertPrComment idempotency", () => {
  it("creates on first call, updates on second", async () => {
    const state: MockState = {
      comments: [],
      nextId: 100,
      calls: { listComments: 0, createComment: 0, updateComment: 0 },
    };
    const oct = makeMockOctokit(state);

    const first = await upsertPrComment({
      octokit: oct,
      owner: "o",
      repo: "r",
      prNumber: 7,
      body: `${COMMENT_MARKER}\nhello v1`,
    });
    expect(first.action).toBe("created");
    expect(first.commentId).toBe(100);
    expect(state.calls.createComment).toBe(1);
    expect(state.calls.updateComment).toBe(0);

    const second = await upsertPrComment({
      octokit: oct,
      owner: "o",
      repo: "r",
      prNumber: 7,
      body: `${COMMENT_MARKER}\nhello v2`,
    });
    expect(second.action).toBe("updated");
    expect(second.commentId).toBe(100); // same id
    expect(state.calls.createComment).toBe(1); // still only 1
    expect(state.calls.updateComment).toBe(1);
    // The body was actually replaced.
    const stored = state.comments.find((c) => c.id === 100);
    expect(stored?.body).toContain("hello v2");
    expect(stored?.body).not.toContain("hello v1");
  });

  it("ignores other people's comments", async () => {
    const state: MockState = {
      comments: [
        { id: 1, user: { login: "someone-else" }, body: "unrelated comment" },
      ],
      nextId: 200,
      calls: { listComments: 0, createComment: 0, updateComment: 0 },
    };
    const oct = makeMockOctokit(state);
    const r = await upsertPrComment({
      octokit: oct,
      owner: "o",
      repo: "r",
      prNumber: 1,
      body: `${COMMENT_MARKER}\nbody`,
    });
    expect(r.action).toBe("created");
    expect(r.commentId).toBe(200);
  });
});
