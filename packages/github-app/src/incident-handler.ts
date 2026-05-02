import { runRca, formatRcaPrompt } from "code-graph-rca";
import type { IncidentIssueApi } from "./types.js";
import {
  INCIDENT_MARKER_PREFIX,
  incidentIssueTitle,
  incidentMarker,
  renderIncidentIssueBody,
} from "./incident-issue.js";
import { withRetry } from "./retry.js";

export interface HandleIncidentOptions {
  /** Authenticated Octokit-shaped client for the target repo. */
  octokit: IncidentIssueApi;
  /** Source incident id (Sentry issue id, or a hash for generic incidents). */
  issueId: string;
  /** Best-effort title for the GitHub issue. */
  title: string;
  /** The raw failure text fed to runRca (stack trace, message, etc). */
  failureText: string;
  /** GitHub repo owner. */
  repoOwner: string;
  /** GitHub repo name. */
  repoName: string;
  /** Local on-disk clone of the repo to RCA against. */
  repoPath: string;
  /** Optional override of the rca step (tests inject canned results). */
  runRcaOverride?: typeof runRca;
}

export interface HandleIncidentResult {
  action: "created" | "updated" | "errored";
  /** GitHub issue number. `0` if creation itself failed. */
  issueNumber: number;
  /** True when RCA threw and we filed a "RCA failed" issue. */
  rcaFailed: boolean;
}

/**
 * Run cgrca on a long-lived clone in response to a production incident, then
 * either open or update the GitHub issue tracking that incident.
 *
 * Idempotency: we look up an existing open issue whose body contains
 * `<!-- cgrca-incident:<id> -->` and edit it in place. Re-fires of the same
 * Sentry issue therefore never stack new GitHub issues — they refresh the
 * candidate table on the existing one. (Closed issues are ignored on
 * purpose — re-firing after a human closed the incident should re-open
 * a fresh issue, not silently edit a closed ticket.)
 *
 * Failure mode: if `runRca` throws (parse error, repo mismatch, timeout),
 * we still file a "RCA failed: <error>" issue rather than dropping the
 * alert silently. The on-call gets paged either way.
 */
export async function handleIncident(
  opts: HandleIncidentOptions,
): Promise<HandleIncidentResult> {
  const rca = opts.runRcaOverride ?? runRca;

  let promptMarkdown = "";
  let candidates: Awaited<ReturnType<typeof runRca>>["causalCandidates"] = [];
  let rcaError: string | undefined;

  try {
    const result = await rca({
      failureScope: { kind: "stack-trace", text: opts.failureText },
      repoRoot: opts.repoPath,
      format: "structured",
    });
    candidates = result.causalCandidates;
    promptMarkdown = formatRcaPrompt({
      failure: { kind: "stack-trace", text: opts.failureText },
      scope: result.scope,
      causalCandidates: result.causalCandidates,
      firstHypothesis: result.firstHypothesis,
      queries: result.queries,
      primarySymbol: result.primarySymbol,
    });
  } catch (err) {
    rcaError = err instanceof Error ? err.message : String(err);
  }

  const body = renderIncidentIssueBody({
    issueId: opts.issueId,
    title: opts.title,
    repoSlug: `${opts.repoOwner}/${opts.repoName}`,
    failureText: opts.failureText,
    promptMarkdown,
    candidates,
    ...(rcaError ? { rcaError } : {}),
  });
  const title = incidentIssueTitle({ title: opts.title, issueId: opts.issueId });

  const existing = await findExistingIssue({
    octokit: opts.octokit,
    owner: opts.repoOwner,
    repo: opts.repoName,
    issueId: opts.issueId,
  });

  if (existing !== null) {
    const res = await withRetry(
      () => opts.octokit.issues.update({
        owner: opts.repoOwner,
        repo: opts.repoName,
        issue_number: existing,
        title,
        body,
      }),
      { name: "issues.update" },
    );
    return {
      action: "updated",
      issueNumber: res.data.number,
      rcaFailed: rcaError !== undefined,
    };
  }

  const res = await withRetry(
    () => opts.octokit.issues.create({
      owner: opts.repoOwner,
      repo: opts.repoName,
      title,
      body,
      labels: rcaError ? ["cgrca-incident", "cgrca-rca-failed"] : ["cgrca-incident"],
    }),
    { name: "issues.create" },
  );
  return {
    action: rcaError ? "errored" : "created",
    issueNumber: res.data.number,
    rcaFailed: rcaError !== undefined,
  };
}

interface FindArgs {
  octokit: IncidentIssueApi;
  owner: string;
  repo: string;
  issueId: string;
}

async function findExistingIssue(args: FindArgs): Promise<number | null> {
  const marker = incidentMarker(args.issueId);
  // Walk up to 4 pages of open issues looking for our marker. We bias to
  // recently-touched first by relying on GitHub's default sort (created desc).
  for (let page = 1; page <= 4; page++) {
    const res = await withRetry(
      () => args.octokit.issues.listForRepo({
        owner: args.owner,
        repo: args.repo,
        state: "open",
        per_page: 100,
        page,
      }),
      { name: "issues.listForRepo" },
    );
    if (res.data.length === 0) return null;
    for (const issue of res.data) {
      const body = issue.body ?? "";
      if (body.includes(marker)) return issue.number;
      // Defensive: also accept the marker prefix appearing exactly once
      // with a stale id mismatch — we still skip it (different incident).
      if (body.includes(INCIDENT_MARKER_PREFIX) && body.includes(args.issueId)) {
        // Only match when the exact marker is present; otherwise keep going.
        // This branch intentionally does nothing — kept for grep-bait.
      }
    }
    if (res.data.length < 100) return null;
  }
  return null;
}
