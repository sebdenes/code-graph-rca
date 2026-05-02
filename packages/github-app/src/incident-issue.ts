import type { CausalCandidate } from "code-graph-rca";

/**
 * Hidden marker that ties a GitHub issue back to the Sentry/incident issue id
 * so re-fires update the same issue instead of opening N duplicates. The
 * format mirrors the PR-comment marker pattern in `comment.ts`, but with the
 * incident id baked in so we can grep the marker out of an issue body.
 */
export function incidentMarker(issueId: string): string {
  return `<!-- cgrca-incident:${issueId} -->`;
}

/** Match any cgrca-incident marker (used when scanning an existing issue body). */
export const INCIDENT_MARKER_PREFIX = "<!-- cgrca-incident:";

export interface IncidentIssueInput {
  /** Sentry/source issue id — embedded as the marker. */
  issueId: string;
  /** GitHub issue title. */
  title: string;
  /** owner/repo slug for the footer. */
  repoSlug: string;
  /** Original failure text we fed to runRca (verbatim, in a code fence). */
  failureText: string;
  /** Markdown prompt cgrca's `formatRcaPrompt` produced — full grounding. */
  promptMarkdown: string;
  /** Top causal candidates for the table. May be empty. */
  candidates: CausalCandidate[];
  /** Optional error string when RCA itself failed. */
  rcaError?: string;
}

const RISK_HIGH = 0.66;
const RISK_MOD = 0.33;

function riskBadge(score: number): string {
  if (score >= RISK_HIGH) return "high";
  if (score >= RISK_MOD) return "mod";
  return "low";
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/** Build the issue title GitHub will see. Stable for an incident id. */
export function incidentIssueTitle(parsed: { title: string; issueId: string }): string {
  // Keep the id in the title too — makes `gh issue list` searchable
  // even if someone strips the body marker.
  return `[cgrca incident ${parsed.issueId}] ${parsed.title}`.slice(0, 240);
}

/** Render the full issue body. Includes the hidden marker for idempotency. */
export function renderIncidentIssueBody(input: IncidentIssueInput): string {
  const lines: string[] = [];
  lines.push(incidentMarker(input.issueId));
  lines.push(`## cgrca incident triage`);
  lines.push("");
  lines.push(`**Source incident id:** \`${input.issueId}\``);
  lines.push(`**Repo analyzed:** \`${input.repoSlug}\` @ HEAD`);
  lines.push("");

  if (input.rcaError) {
    lines.push("> **RCA failed** — surfacing the alert anyway so the on-call sees it.");
    lines.push("");
    lines.push("```");
    lines.push(input.rcaError);
    lines.push("```");
    lines.push("");
    lines.push("### Original failure");
    lines.push("");
    lines.push("```");
    lines.push(input.failureText);
    lines.push("```");
    lines.push("");
    lines.push(footer(input.issueId));
    return lines.join("\n");
  }

  lines.push("### Ranked candidates");
  lines.push("");
  if (input.candidates.length === 0) {
    lines.push("_(graph analysis returned no causal candidates — see prompt below)_");
  } else {
    lines.push("| # | symbol | file:line | risk | rationale |");
    lines.push("|---|--------|-----------|------|-----------|");
    input.candidates.slice(0, 5).forEach((c, i) => {
      const file = c.file ?? "(unknown)";
      const line = c.line ?? 0;
      lines.push(
        `| ${i + 1} | \`${escapePipes(c.name)}\` | ${escapePipes(file)}:${line} | ${riskBadge(c.score)} | ${escapePipes(c.rationale)} |`,
      );
    });
  }
  lines.push("");

  lines.push("### Original failure");
  lines.push("");
  lines.push("```");
  lines.push(input.failureText);
  lines.push("```");
  lines.push("");

  lines.push("<details><summary>Full RCA prompt (paste into your LLM for grounded triage)</summary>");
  lines.push("");
  lines.push(input.promptMarkdown);
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push(footer(input.issueId));
  return lines.join("\n");
}

function footer(issueId: string): string {
  return [
    "---",
    `*Re-fires of source incident \`${issueId}\` will edit this issue in place. To re-run RCA manually: \`cgrca rca --stack-trace - < failure.txt\`.*`,
    "*Posted by [code-graph-rca](https://github.com/sebdenes/code-graph-rca) incident surface.*",
  ].join("\n");
}
