import type { CausalCandidate, ImpactNode, RecentChange } from "code-graph-rca";

/** Marker hidden in the comment so we can find & update our own comment. */
export const COMMENT_MARKER = "<!-- cgrca-pr-bot:v1 -->";

export interface RankedSymbol {
  /** Symbol name (e.g. `login`). */
  name: string;
  /** Repo-relative file. */
  file: string;
  /** Line where the symbol starts. */
  line: number;
  /** Final composite score, higher = riskier. */
  score: number;
  /** One-line explanation. */
  rationale: string;
  /** Optional reference to the most recent commit in this neighborhood. */
  recentCommit?: { sha: string; daysAgo: number };
}

export interface UntestedCaller {
  name: string;
  file: string;
  line: number;
  /** True when no test file in the same dir mentions this caller. */
  noColocatedTest: boolean;
}

export interface UnresolvedHint {
  /** The unresolved name (target of the call). */
  target: string;
  /** Symbol from which the unresolved call originates. */
  fromSymbol: string;
}

export interface CommentInput {
  changedSymbolCount: number;
  rankedSymbols: RankedSymbol[];
  blastRadius: {
    /** Total transitively-affected callers across the PR. */
    totalAffected: number;
    /** Top untested callers worth a look. */
    topUntested: UntestedCaller[];
  };
  recentActivity: Array<{
    sha: string;
    author: string;
    subject: string;
    daysAgo: number;
  }>;
  unresolvedHints: UnresolvedHint[];
}

const RISK_HIGH = 0.66;
const RISK_MOD = 0.33;

function riskBadge(score: number): string {
  if (score >= RISK_HIGH) return "🔴 high";
  if (score >= RISK_MOD) return "🟡 mod";
  return "🟢 low";
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/** Produce the final Markdown PR comment body (idempotency marker included). */
export function renderPrComment(input: CommentInput): string {
  const lines: string[] = [];
  lines.push(COMMENT_MARKER);
  lines.push("## 🔍 cgrca review");
  lines.push("");
  lines.push(
    `**Changed symbols:** ${input.changedSymbolCount} (top-${input.rankedSymbols.length} ranked by causal score across the PR)`,
  );
  lines.push("");

  if (input.rankedSymbols.length > 0) {
    lines.push("| # | symbol | file:line | risk | 1-line rationale |");
    lines.push("|---|--------|-----------|------|------------------|");
    input.rankedSymbols.forEach((r, i) => {
      lines.push(
        `| ${i + 1} | \`${escapePipes(r.name)}\` | ${escapePipes(r.file)}:${r.line} | ${riskBadge(r.score)} | ${escapePipes(r.rationale)} |`,
      );
    });
    lines.push("");
  }

  lines.push(
    `**Blast radius:** ${input.blastRadius.totalAffected} callers transitively affected. Top-${input.blastRadius.topUntested.length} untested callers worth a look:`,
  );
  lines.push("");
  if (input.blastRadius.topUntested.length === 0) {
    lines.push("- _(none — all transitive callers have a colocated test file)_");
  } else {
    for (const u of input.blastRadius.topUntested) {
      const tail = u.noColocatedTest ? " — no test file in the same dir" : "";
      lines.push(`- \`${u.name}\` (${u.file}:${u.line})${tail}`);
    }
  }
  lines.push("");

  lines.push(
    `**Recent activity in this neighborhood:** ${input.recentActivity.length} commits in the last 30 days touching the changed symbols' lines:`,
  );
  lines.push("");
  if (input.recentActivity.length === 0) {
    lines.push("- _(no commits in the last 30 days)_");
  } else {
    for (const c of input.recentActivity) {
      lines.push(
        `- \`${c.sha.slice(0, 7)}\` ${c.author} — "${c.subject}" (${c.daysAgo}d ago)`,
      );
    }
  }
  lines.push("");

  if (input.unresolvedHints.length > 0) {
    lines.push(
      "<details><summary>Unresolved call hints (grep-bait for the LLM that reviews this PR)</summary>",
    );
    lines.push("");
    for (const h of input.unresolvedHints) {
      lines.push(`- \`${h.target}\` (referenced from \`${h.fromSymbol}\`)`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "*🤖 Posted by [code-graph-rca](https://github.com/sebdenes/code-graph-rca) — RCA infrastructure for AI-built code.*",
  );

  return lines.join("\n");
}

/** Short comment for "no top-level symbol changes detected" PRs. */
export function renderSkipComment(): string {
  return [
    COMMENT_MARKER,
    "## 🔍 cgrca review",
    "",
    "No top-level symbol changes detected — looks like a docs/config-only PR. Skipping graph analysis.",
    "",
    "---",
    "*🤖 Posted by [code-graph-rca](https://github.com/sebdenes/code-graph-rca) — RCA infrastructure for AI-built code.*",
  ].join("\n");
}

/** Convert a `CausalCandidate` -> `RankedSymbol` for the table. */
export function candidateToRanked(c: CausalCandidate): RankedSymbol {
  const recent = mostRecentCommit(c.recentChanges);
  return {
    name: c.name,
    file: c.file ?? "(unknown)",
    line: c.line ?? 0,
    score: c.score,
    rationale: c.rationale,
    ...(recent ? { recentCommit: recent } : {}),
  };
}

function mostRecentCommit(rcs: RecentChange[]): { sha: string; daysAgo: number } | undefined {
  if (rcs.length === 0) return undefined;
  const sorted = [...rcs].sort((a, b) => a.daysAgo - b.daysAgo);
  const top = sorted[0];
  if (!top) return undefined;
  return { sha: top.commit, daysAgo: top.daysAgo };
}

/** Pick top-K untested callers from a flat impact list (one symbol). */
export function pickTopUntested(
  nodes: ImpactNode[],
  limit: number,
): UntestedCaller[] {
  const untested = nodes
    .filter((n) => n.distance > 0 && n.testCoverage.length === 0)
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, limit);
  return untested.map((n) => ({
    name: n.name,
    file: n.file,
    line: n.line,
    noColocatedTest: true,
  }));
}
