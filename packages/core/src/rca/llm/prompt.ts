import type { CausalCandidate } from "../../types.js";
import type { BodySnippet } from "./body.js";

/**
 * Prompt builder for v0.5 Phase 2.
 *
 * Renders the structured RCA prompt the LLM sees: the failure description
 * (verbatim, untrimmed), the ranked candidate set with body previews and
 * 1-hop neighbors, and a strict JSON output schema.
 *
 * Token discipline lives at the call site — this builder doesn't know the
 * cap, just what to render. Pre-trim `bodyByCandidate`'s entries before
 * calling if you need to fit a budget.
 */

export interface CandidateBundle {
  rank: number;
  candidate: CausalCandidate;
  body: BodySnippet | null;
  /** Up to ~3 caller names (best-by-score), rendered as "name (file:line)". */
  callers: string[];
  /** Up to ~3 callee names. */
  callees: string[];
}

export const SYSTEM_PROMPT = `You are an RCA assistant. You will receive (a) a failure description and (b) a ranked list of candidate code locations from a static graph analyzer. Your job: pick the single most likely root cause, or honestly say no candidate is plausible.

Rules:
- Pick from the candidate set. Do NOT invent file paths or line numbers that aren't in the candidates.
- If no candidate is plausible (e.g. the failure points at config or data, not code in the set), set rootCause to null and explain in reasoning.
- Be specific: hypothesis must reference the failure's specific symptom + the picked code path, not a generic "this function might be wrong".
- Confidence is honest: 0.9 = very sure, 0.5 = best guess, 0.2 = grasping at straws. Don't anchor at 0.7.`;

export function renderUserPrompt(
  failureDescription: string,
  bundles: CandidateBundle[],
): string {
  const parts: string[] = [];

  parts.push("## Failure");
  parts.push(failureDescription.trim());
  parts.push("");
  parts.push("## Candidates (ranked by static analyzer)");

  for (const b of bundles) {
    const c = b.candidate;
    parts.push("");
    parts.push(`### Candidate ${b.rank} — score ${c.score.toFixed(2)} · role ${c.role}`);
    parts.push(`File: ${c.file ?? "(unknown)"}${c.line != null ? `:${c.line}` : ""}`);
    parts.push(`Symbol: ${c.name}`);
    if (c.rationale) {
      // Strip newlines from rationale so it stays a single line in the prompt.
      parts.push(`Why ranked here: ${c.rationale.replace(/\s+/g, " ")}`);
    }
    if (b.callers.length > 0) {
      parts.push(`Callers: ${b.callers.join(", ")}`);
    }
    if (b.callees.length > 0) {
      parts.push(`Callees: ${b.callees.join(", ")}`);
    }
    if (b.body) {
      parts.push("Body:");
      parts.push("```" + b.body.language);
      parts.push(b.body.body);
      parts.push("```");
      if (b.body.truncated) {
        parts.push(`(body truncated; full span past ${b.body.endLine})`);
      }
    } else {
      parts.push("Body: (source not available)");
    }
  }

  parts.push("");
  parts.push("## Output");
  parts.push("Respond as JSON only, matching this schema exactly:");
  parts.push("```json");
  parts.push(`{
  "rootCause": {
    "file": "<path relative to repo root>",
    "line": <int>,
    "symbol": "<name>",
    "hypothesis": "<≤3 sentences>",
    "confidence": <0..1>
  } | null,
  "alternatives": [{ "file": "...", "line": 0, "symbol": "...", "why": "..." }],
  "reasoning": "<1-2 sentences on which candidate(s) you weighed>"
}`);
  parts.push("```");

  return parts.join("\n");
}

/** Approximate token count: 1 token ≈ 4 chars for English/code. Caller uses
 * this as a budget pre-check; provider-reported usage is the truth post-call. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
