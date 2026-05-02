/**
 * Public surface for v0.5 Phase 2 (LLM-augmented RCA).
 *
 * The `runLlmRca` function takes a non-LLM RcaResult, hydrates each
 * candidate with body + neighbors, builds the prompt, calls the chosen
 * provider, validates the JSON, and returns an `RcaLlmResult` that bundles
 * the LLM verdict alongside the underlying static ranking.
 *
 * Implementation note: this is a separate path from `runRca` so that the
 * static fallback always remains available — `--llm` is a re-rank, not a
 * replacement.
 */

import type { CausalCandidate } from "../../types.js";
import type { Db } from "../../graph/db.js";
import { callersOf, calleesOf, definitionOf } from "../../graph/queries.js";
import { fetchBody, type BodySnippet } from "./body.js";
import {
  approxTokens,
  renderUserPrompt,
  SYSTEM_PROMPT,
  type CandidateBundle,
} from "./prompt.js";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import type { LlmProvider } from "./provider.js";

export interface RcaLlmRequest {
  failureDescription: string;
  candidates: CausalCandidate[];
  db: Db;
  repoRoot: string;
  /** "anthropic" | "openai". */
  provider: string;
  /** Provider-specific model id; defaults to the provider's default. */
  model?: string;
  /** Cap on input tokens we'll send. Defaults to 10_000. */
  maxInputTokens?: number;
  /** Cap on output tokens. Defaults to 1_500. */
  maxOutputTokens?: number;
  /** How many candidates to send to the LLM. Defaults to 10 (or all if fewer). */
  topK?: number;
  /** How many lines to include per body. Defaults to 30. */
  maxBodyLines?: number;
}

export interface RcaLlmVerdict {
  rootCause: {
    file: string;
    line: number;
    symbol: string;
    hypothesis: string;
    confidence: number;
  } | null;
  alternatives: Array<{ file: string; line: number; symbol: string; why: string }>;
  reasoning: string;
}

export interface RcaLlmResult {
  verdict: RcaLlmVerdict;
  /** Provider name actually used. */
  provider: string;
  /** Model id the provider echoed back (may differ from the requested id). */
  model: string;
  /** Token + cost accounting from the provider's response. */
  cost: { inputTokens: number; outputTokens: number; usd: number };
  latencyMs: number;
  /** True if the prompt was trimmed to fit `maxInputTokens`. */
  trimmed: boolean;
}

const PROVIDERS: Record<string, LlmProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
};

export interface BuildPromptOpts {
  failureDescription: string;
  candidates: CausalCandidate[];
  db: Db;
  repoRoot: string;
  topK?: number;
  maxBodyLines?: number;
  /** Optional cap; trim bundles until system+user fits. Skip cap if undefined. */
  maxInputTokens?: number;
}

export interface BuiltPrompt {
  /** System prompt — instructions + JSON schema rules. */
  system: string;
  /** User prompt — failure + candidates + JSON schema. */
  user: string;
  /** True if the prompt was trimmed to fit `maxInputTokens`. */
  trimmed: boolean;
  /** Bundles after any trimming, for downstream inspection. */
  bundles: CandidateBundle[];
}

/**
 * Build the LLM-ready prompt without making any network call. Reused by:
 * - `runLlmRca` (CLI `--llm`) — calls a provider afterwards
 * - MCP `cgrca_rcaWithReasoning` — returns the prompt for the host LLM
 *   (Claude in Claude Code, etc.) to reason over inline. No API key needed.
 */
export function buildLlmPrompt(opts: BuildPromptOpts): BuiltPrompt {
  const topK = opts.topK ?? 10;
  const maxBodyLines = opts.maxBodyLines ?? 30;

  const subset = opts.candidates.slice(0, topK);
  const bundles: CandidateBundle[] = subset.map((c, i) => {
    let body: BodySnippet | null = null;
    if (c.file && c.line != null) {
      // Use definitionOf to get the precise [start, end] range; if missing,
      // fall back to a small window around the candidate's reported line.
      const defs = definitionOf(opts.db, c.name);
      const def = defs.find((d) => d.file === c.file) ?? defs[0];
      const startLine = def?.startLine ?? Math.max(1, c.line - 5);
      const endLine = def?.endLine ?? c.line + maxBodyLines;
      body = fetchBody(opts.repoRoot, c.file, startLine, endLine, maxBodyLines);
    }
    const callerTree = callersOf(opts.db, c.name, { depth: 1, minConfidence: 0.5 });
    const calleeTree = calleesOf(opts.db, c.name, { depth: 1 });
    return {
      rank: i + 1,
      candidate: c,
      body,
      callers: extractNeighborNames(callerTree, 3),
      callees: extractNeighborNames(calleeTree, 3),
    };
  });

  // Trim bundles until the prompt fits the input budget. Strategy:
  //  1) Drop callers/callees first (cheap context loss)
  //  2) Then trim each body to half-length
  //  3) Then drop the lowest-ranked candidate entirely
  // Stop the first time we fit. We don't aim for "tightest possible" — just
  // "below the cap." Skip entirely if maxInputTokens is undefined.
  let trimmed = false;
  let user = renderUserPrompt(opts.failureDescription, bundles);
  if (opts.maxInputTokens !== undefined) {
    while (
      approxTokens(SYSTEM_PROMPT) + approxTokens(user) > opts.maxInputTokens &&
      bundles.length > 0
    ) {
      trimmed = true;
      if (bundles.some((b) => b.callers.length > 0 || b.callees.length > 0)) {
        for (const b of bundles) {
          b.callers = [];
          b.callees = [];
        }
      } else if (bundles.some((b) => b.body && b.body.body.split("\n").length > 5)) {
        for (const b of bundles) {
          if (b.body) {
            const lines = b.body.body.split("\n");
            const half = Math.max(5, Math.floor(lines.length / 2));
            b.body = { ...b.body, body: lines.slice(0, half).join("\n"), truncated: true };
          }
        }
      } else {
        bundles.pop();
      }
      user = renderUserPrompt(opts.failureDescription, bundles);
    }
  }
  return { system: SYSTEM_PROMPT, user, trimmed, bundles };
}

export async function runLlmRca(req: RcaLlmRequest): Promise<RcaLlmResult> {
  const provider = PROVIDERS[req.provider];
  if (!provider) {
    throw new Error(`unknown LLM provider: ${req.provider} (known: ${Object.keys(PROVIDERS).join(",")})`);
  }
  const model = req.model && req.model.length > 0 ? req.model : provider.defaultModel();
  const maxOutputTokens = req.maxOutputTokens ?? 1_500;

  const built = buildLlmPrompt({
    failureDescription: req.failureDescription,
    candidates: req.candidates,
    db: req.db,
    repoRoot: req.repoRoot,
    ...(req.topK !== undefined ? { topK: req.topK } : {}),
    ...(req.maxBodyLines !== undefined ? { maxBodyLines: req.maxBodyLines } : {}),
    maxInputTokens: req.maxInputTokens ?? 10_000,
  });
  const { system, user, trimmed } = built;

  const result = await provider.call({
    system,
    user,
    model,
    maxOutputTokens,
    responseShape: "json",
  });

  const verdict = parseVerdict(result.content);

  return {
    verdict,
    provider: provider.name,
    model: result.modelEcho,
    cost: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      usd: result.costUsd,
    },
    latencyMs: result.latencyMs,
    trimmed,
  };
}

interface CallerOrCalleeNode {
  name: string;
  file?: string | null;
  line?: number | null;
  callers?: CallerOrCalleeNode[];
  callees?: CallerOrCalleeNode[];
}

function extractNeighborNames(tree: unknown, max: number): string[] {
  const node = tree as CallerOrCalleeNode | null | undefined;
  if (!node) return [];
  const list = node.callers ?? node.callees ?? [];
  return list.slice(0, max).map((n) => {
    if (n.file && n.line != null) return `${n.name} (${basename(n.file)}:${n.line})`;
    return n.name;
  });
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function parseVerdict(raw: string): RcaLlmVerdict {
  // Strip code fences if the model added them despite instructions.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `LLM verdict parse failed: ${err instanceof Error ? err.message : String(err)}; raw=${cleaned.slice(0, 300)}`,
    );
  }
  // Light validation; we don't enforce the schema strictly so a slightly
  // off response still lands. Caller can decide what to do with nulls.
  const v = parsed as Partial<RcaLlmVerdict>;
  return {
    rootCause: v.rootCause ?? null,
    alternatives: Array.isArray(v.alternatives) ? v.alternatives : [],
    reasoning: typeof v.reasoning === "string" ? v.reasoning : "",
  };
}
