/**
 * Re-export of better-sqlite3's Database type, which is the handle the cgrca
 * core returns from `indexScope` and accepts in `buildImpact`. better-sqlite3
 * is already a transitive dep of `code-graph-rca`, so no extra dep is needed.
 */
import type Database from "better-sqlite3";
export type Db = Database.Database;

/** Subset of the Octokit REST client we touch for PR comments. */
export interface PrCommentApi {
  issues: {
    listComments(args: {
      owner: string;
      repo: string;
      issue_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{ data: Array<{ id: number; user: { login: string } | null; body?: string | null }> }>;
    createComment(args: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<{ data: { id: number; body?: string | null } }>;
    updateComment(args: {
      owner: string;
      repo: string;
      comment_id: number;
      body: string;
    }): Promise<{ data: { id: number; body?: string | null } }>;
  };
  pulls: {
    listFiles(args: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{
      data: Array<{
        filename: string;
        status?: string;
        patch?: string;
      }>;
    }>;
  };
}
