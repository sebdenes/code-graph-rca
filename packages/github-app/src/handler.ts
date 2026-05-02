import {
  buildImpact,
  indexScope,
  recentlyChangedNear,
  runRca,
  type CausalCandidate,
  type ImpactNode,
  type ImpactResponse,
} from "code-graph-rca";
import {
  findChangedSymbols,
  parseHunksFromPatch,
  type ChangedFile,
  type ChangedSymbol,
} from "./changed-symbols.js";
import {
  candidateToRanked,
  pickTopUntested,
  renderPrComment,
  renderSkipComment,
  type CommentInput,
  type RankedSymbol,
  type UnresolvedHint,
  type UntestedCaller,
} from "./comment.js";
import { clonePrHead } from "./clone.js";
import { upsertPrComment } from "./idempotency.js";
import type { PrCommentApi } from "./types.js";

// Re-export so action-cli (and future incident-trigger CLIs) can pull a
// single entry point — `import { handlePullRequest, handleIncident } from "./handler.js"`.
export { handleIncident } from "./incident-handler.js";
export type {
  HandleIncidentOptions,
  HandleIncidentResult,
} from "./incident-handler.js";

/** Minimal PR payload subset we read; matches @octokit/webhooks pull_request payload. */
export interface PrPayload {
  action: "opened" | "synchronize" | string;
  number: number;
  pull_request: {
    number: number;
    head: {
      sha: string;
      ref: string;
      repo: { clone_url: string; full_name: string } | null;
    };
    base: {
      repo: { full_name: string; owner: { login: string }; name: string };
    };
  };
  repository: {
    full_name: string;
    name: string;
    owner: { login: string };
  };
}

export interface HandlePrOptions {
  /** Octokit instance authenticated for this installation. */
  octokit: PrCommentApi;
  /** Verified webhook payload for pull_request.opened|synchronize. */
  payload: PrPayload;
  /** Optional installation token (for cloning private repos). */
  token?: string;
  /**
   * Optional override: bypass clone and run against an already-checked-out
   * worktree. Used by tests.
   */
  worktreeOverride?: string;
  /** Optional override: precomputed list of changed files (for tests). */
  changedFilesOverride?: ChangedFile[];
}

export interface HandlePrResult {
  status: "skipped-no-symbols" | "posted";
  commentAction: "created" | "updated" | "none";
  commentId: number | null;
  changedSymbolCount: number;
  body: string;
}

/**
 * Top-level PR handler. Steps:
 *   1. resolve PR head sha + diff (changed files + line ranges)
 *   2. clone PR head into tmp worktree
 *   3. for each changed top-level symbol, run RCA + impact
 *   4. aggregate ranked candidates, blast radius, recent activity, unresolved hints
 *   5. post (or update) a single comment
 */
export async function handlePullRequest(
  opts: HandlePrOptions,
): Promise<HandlePrResult> {
  const owner = opts.payload.repository.owner.login;
  const repo = opts.payload.repository.name;
  const prNumber = opts.payload.pull_request.number;

  const changedFiles = opts.changedFilesOverride
    ? opts.changedFilesOverride
    : await fetchChangedFiles(opts.octokit, owner, repo, prNumber);

  let workdir: string;
  let cleanup = (): void => {};
  if (opts.worktreeOverride) {
    workdir = opts.worktreeOverride;
  } else {
    const cloneUrl = opts.payload.pull_request.head.repo?.clone_url;
    if (!cloneUrl) throw new Error("PR head repo missing clone_url");
    const cloned = clonePrHead({
      cloneUrl,
      sha: opts.payload.pull_request.head.sha,
      ...(opts.token ? { token: opts.token } : {}),
    });
    workdir = cloned.dir;
    cleanup = cloned.cleanup;
  }

  try {
    const aggregated = await analyzeWorktree({
      worktree: workdir,
      changedFiles,
    });

    if (aggregated.changedSymbols.length === 0) {
      const body = renderSkipComment();
      const upsert = await upsertPrComment({
        octokit: opts.octokit,
        owner,
        repo,
        prNumber,
        body,
      });
      return {
        status: "skipped-no-symbols",
        commentAction: upsert.action,
        commentId: upsert.commentId,
        changedSymbolCount: 0,
        body,
      };
    }

    const body = renderPrComment(aggregated.commentInput);
    const upsert = await upsertPrComment({
      octokit: opts.octokit,
      owner,
      repo,
      prNumber,
      body,
    });
    return {
      status: "posted",
      commentAction: upsert.action,
      commentId: upsert.commentId,
      changedSymbolCount: aggregated.changedSymbols.length,
      body,
    };
  } finally {
    cleanup();
  }
}

interface AnalyzeArgs {
  worktree: string;
  changedFiles: ChangedFile[];
}

interface AnalyzeResult {
  changedSymbols: ChangedSymbol[];
  commentInput: CommentInput;
}

async function analyzeWorktree(args: AnalyzeArgs): Promise<AnalyzeResult> {
  // Index the whole worktree once. We could limit to changed files, but the
  // graph queries (callers/recency) need the full scope to be useful.
  const indexed = await indexScope({
    repoRoot: args.worktree,
    maxFiles: 2000,
  });

  let changedSymbols: ChangedSymbol[] = [];
  try {
    changedSymbols = findChangedSymbols({
      db: indexed.db,
      repoRoot: args.worktree,
      files: args.changedFiles,
    });
  } finally {
    // Close the indexed DB before we run RCA (each runRca opens its own).
    indexed.db.close();
  }

  if (changedSymbols.length === 0) {
    return {
      changedSymbols,
      commentInput: emptyCommentInput(),
    };
  }

  const allCandidates: CausalCandidate[] = [];
  const allImpactNodes: ImpactNode[] = [];
  const recentByCommit = new Map<
    string,
    { sha: string; author: string; subject: string; daysAgo: number }
  >();
  const unresolvedHints: UnresolvedHint[] = [];
  const seenHints = new Set<string>();
  let totalAffected = 0;

  for (const sym of changedSymbols) {
    let rca;
    try {
      rca = await runRca({
        failureScope: { kind: "symbol", name: sym.name, file: sym.file },
        repoRoot: args.worktree,
      });
    } catch {
      continue;
    }
    for (const c of rca.causalCandidates) {
      allCandidates.push(c);
      for (const t of c.unresolvedCallTargets) {
        const k = `${c.name}::${t}`;
        if (seenHints.has(k)) continue;
        seenHints.add(k);
        unresolvedHints.push({ target: t, fromSymbol: c.name });
      }
    }

    // Re-index for impact + recency. (runRca closes its own db.)
    const idx2 = await indexScope({ repoRoot: args.worktree, maxFiles: 2000 });
    try {
      let impact: ImpactResponse | null = null;
      try {
        impact = buildImpact({
          symbolName: sym.name,
          file: sym.file,
          depth: 3,
          repoRoot: args.worktree,
          db: idx2.db,
        });
      } catch {
        impact = null;
      }
      if (impact) {
        for (const n of impact.nodes) {
          if (n.distance > 0) totalAffected += 1;
          allImpactNodes.push(n);
        }
      }

      try {
        const recent = recentlyChangedNear(idx2.db, sym.name, {
          repoRoot: args.worktree,
          sinceDays: 30,
        });
        const now = Date.now();
        for (const r of recent) {
          if (recentByCommit.has(r.commit)) continue;
          const t = Date.parse(r.date);
          const daysAgo = Number.isFinite(t)
            ? Math.max(0, Math.round((now - t) / 86_400_000))
            : 0;
          recentByCommit.set(r.commit, {
            sha: r.commit,
            author: r.author,
            subject: r.subject,
            daysAgo,
          });
        }
      } catch {
        // git recency may fail outside a real repo; ignore.
      }
    } finally {
      idx2.db.close();
    }
  }

  const rankedSymbols = topRankedSymbols(allCandidates, changedSymbols, 3);
  const topUntested = pickTopUntested(allImpactNodes, 3);

  const recentActivity = [...recentByCommit.values()]
    .sort((a, b) => a.daysAgo - b.daysAgo)
    .slice(0, 5);

  return {
    changedSymbols,
    commentInput: {
      changedSymbolCount: changedSymbols.length,
      rankedSymbols,
      blastRadius: { totalAffected, topUntested },
      recentActivity,
      unresolvedHints: unresolvedHints.slice(0, 8),
    },
  };
}

function topRankedSymbols(
  candidates: CausalCandidate[],
  changed: ChangedSymbol[],
  limit: number,
): RankedSymbol[] {
  // Prefer candidates whose name matches a changed symbol; fall back to top
  // scorers across all candidates so the table is never empty.
  const changedNames = new Set(changed.map((c) => c.name));
  const inChange = candidates
    .filter((c) => changedNames.has(c.name))
    .sort((a, b) => b.score - a.score);
  const byName = new Map<string, CausalCandidate>();
  for (const c of inChange) {
    if (!byName.has(c.name)) byName.set(c.name, c);
  }
  let ranked = [...byName.values()];
  if (ranked.length < limit) {
    const extra = candidates
      .filter((c) => !byName.has(c.name))
      .sort((a, b) => b.score - a.score);
    for (const c of extra) {
      ranked.push(c);
      byName.set(c.name, c);
      if (ranked.length >= limit) break;
    }
  }
  ranked = ranked.slice(0, limit);
  // Last-resort fallback: synthesize entries directly from `changed` so we
  // always render at least one row when changed symbols exist.
  if (ranked.length === 0 && changed.length > 0) {
    return changed.slice(0, limit).map((s) => ({
      name: s.name,
      file: s.file,
      line: s.startLine,
      score: 0.5,
      rationale: "Modified in this PR — graph analysis returned no extra signals.",
    }));
  }
  return ranked.map(candidateToRanked);
}

function emptyCommentInput(): CommentInput {
  return {
    changedSymbolCount: 0,
    rankedSymbols: [],
    blastRadius: { totalAffected: 0, topUntested: [] as UntestedCaller[] },
    recentActivity: [],
    unresolvedHints: [],
  };
}

async function fetchChangedFiles(
  octokit: PrCommentApi,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ChangedFile[]> {
  const out: ChangedFile[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    if (res.data.length === 0) break;
    for (const f of res.data) {
      out.push({
        path: f.filename,
        ...(f.status ? { status: f.status } : {}),
        hunks: parseHunksFromPatch(f.patch ?? null),
      });
    }
    if (res.data.length < 100) break;
  }
  return out;
}
