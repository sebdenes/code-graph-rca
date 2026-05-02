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

/**
 * Subset of the Octokit REST client we touch for the incident-response
 * surface (open or update a GitHub issue when a Sentry alert fires).
 *
 * Kept structurally separate from `PrCommentApi` so the PR-review tests
 * can keep their tiny mock and the incident tests their own — neither
 * mock has to grow stubs for the other surface.
 */
export interface IncidentIssueApi {
  issues: {
    listForRepo(args: {
      owner: string;
      repo: string;
      state?: "open" | "closed" | "all";
      per_page?: number;
      page?: number;
    }): Promise<{
      data: Array<{ number: number; title: string; body?: string | null; state?: string }>;
    }>;
    create(args: {
      owner: string;
      repo: string;
      title: string;
      body: string;
      labels?: string[];
    }): Promise<{ data: { number: number; html_url?: string } }>;
    update(args: {
      owner: string;
      repo: string;
      issue_number: number;
      title?: string;
      body?: string;
      state?: "open" | "closed";
    }): Promise<{ data: { number: number; html_url?: string } }>;
  };
}
