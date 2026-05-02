/**
 * LLM provider abstraction for v0.5 Phase 2 (LLM-augmented RCA).
 *
 * Two providers ship: Anthropic (`anthropic`) and OpenAI-compatible
 * (`openai`, also covers Together / Groq / local llama.cpp / etc.). Each
 * is a thin fetch wrapper — no SDK dependency in core, matching how
 * the eval-harness ships zero-dep.
 *
 * Pricing tracked here is honest and dated: when the model lineup or
 * pricing shifts, update the table at the bottom and bump the comment.
 * The cost field on `LlmCallResult` lets the CLI/eval surface
 * per-call $ without callers having to re-derive from token counts.
 */

export interface LlmCallOpts {
  /** System prompt. */
  system: string;
  /** User prompt (the RCA candidate set + failure description). */
  user: string;
  /** Model id (provider-specific). */
  model: string;
  /** Cap on output tokens. Input cap is enforced by the caller. */
  maxOutputTokens: number;
  /**
   * `"json"` adds a "respond with JSON only" hint to the system prompt
   * and (for providers that support it) tool-use forcing. The caller is
   * responsible for parsing — providers don't deserialize.
   */
  responseShape?: "json" | "text";
}

export interface LlmCallResult {
  /** Raw model output (text). For json-shape, this is the JSON string. */
  content: string;
  /** Token accounting per provider report. */
  inputTokens: number;
  outputTokens: number;
  /** Cost estimate in USD (approximate; based on the pricing table below). */
  costUsd: number;
  /** Wall-clock ms for the network round-trip. */
  latencyMs: number;
  /** Provider-reported model id (may differ from request when aliased). */
  modelEcho: string;
}

export interface LlmProvider {
  /** Provider name — `"anthropic"` or `"openai"`. */
  name: string;
  /** Returns the default model id when none is specified. */
  defaultModel(): string;
  /**
   * Issues one synchronous call. Throws on auth/network failure; never
   * silently degrades. Caller decides whether to fall back to non-LLM RCA.
   */
  call(opts: LlmCallOpts): Promise<LlmCallResult>;
}

// ---------------------------------------------------------------------------
// Pricing — input/output USD per 1M tokens, dated 2026-05.
// Source: each provider's public pricing page on the date noted.
// Update when models or pricing change; honest accounting matters because
// the CLI surfaces $ per call to users.
// ---------------------------------------------------------------------------
export interface PriceRow {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const PRICING: Record<string, PriceRow> = {
  // Anthropic (claude.ai/pricing as of 2026-05-02)
  "claude-opus-4-7": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 1, outputPerMillion: 5 },
  // OpenAI (platform.openai.com/docs/pricing as of 2026-05-02)
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const row = PRICING[model];
  if (!row) return 0; // Unknown model → don't fabricate; report 0 + flag in caller.
  return (
    (inputTokens / 1_000_000) * row.inputPerMillion +
    (outputTokens / 1_000_000) * row.outputPerMillion
  );
}
