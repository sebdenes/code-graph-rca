import type { PrCommentApi } from "./types.js";
import { COMMENT_MARKER } from "./comment.js";
import { withRetry } from "./retry.js";

export interface UpsertArgs {
  octokit: PrCommentApi;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
}

export interface UpsertResult {
  /** "created" when a fresh comment was posted, "updated" when an existing comment was edited. */
  action: "created" | "updated";
  commentId: number;
}

/**
 * Find an existing cgrca comment on the PR (matching `COMMENT_MARKER`) and
 * update it; otherwise create a new one. Idempotent: repeated calls on
 * `synchronize` events update the same comment.
 */
export async function upsertPrComment(args: UpsertArgs): Promise<UpsertResult> {
  const existing = await findExistingComment(args);
  if (existing !== null) {
    const res = await withRetry(
      () => args.octokit.issues.updateComment({
        owner: args.owner,
        repo: args.repo,
        comment_id: existing,
        body: args.body,
      }),
      { name: "issues.updateComment" },
    );
    return { action: "updated", commentId: res.data.id };
  }
  const res = await withRetry(
    () => args.octokit.issues.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.prNumber,
      body: args.body,
    }),
    { name: "issues.createComment" },
  );
  return { action: "created", commentId: res.data.id };
}

async function findExistingComment(args: UpsertArgs): Promise<number | null> {
  // Walk up to 4 pages (400 comments). PRs with more cgrca comments than that
  // probably have other problems; we only need the first match.
  for (let page = 1; page <= 4; page++) {
    const res = await withRetry(
      () => args.octokit.issues.listComments({
        owner: args.owner,
        repo: args.repo,
        issue_number: args.prNumber,
        per_page: 100,
        page,
      }),
      { name: "issues.listComments" },
    );
    if (res.data.length === 0) return null;
    for (const c of res.data) {
      const body = c.body ?? "";
      if (body.includes(COMMENT_MARKER)) return c.id;
    }
    if (res.data.length < 100) return null;
  }
  return null;
}
