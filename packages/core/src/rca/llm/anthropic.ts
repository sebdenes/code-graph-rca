import {
  estimateCostUsd,
  type LlmCallOpts,
  type LlmCallResult,
  type LlmProvider,
} from "./provider.js";

/**
 * Anthropic Messages API provider.
 * Auth: ANTHROPIC_API_KEY env var.
 *
 * Endpoint: https://api.anthropic.com/v1/messages
 * Spec: docs.anthropic.com/api/messages — only `model`, `messages`,
 *       `system`, `max_tokens` are required.
 */

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}

export const anthropicProvider: LlmProvider = {
  name: "anthropic",

  defaultModel(): string {
    return "claude-sonnet-4-6";
  },

  async call(opts: LlmCallOpts): Promise<LlmCallResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "anthropic provider: ANTHROPIC_API_KEY is not set (required for --llm).",
      );
    }
    // For json-shape, append a strict instruction. We don't use Anthropic's
    // tool-use forcing because the schema is fixed and a JSON-only-output
    // hint is reliable enough at sonnet-4-6 quality.
    const system =
      opts.responseShape === "json"
        ? `${opts.system}\n\nRespond with valid JSON only. No prose, no code fences.`
        : opts.system;

    const body = {
      model: opts.model,
      max_tokens: opts.maxOutputTokens,
      system,
      messages: [{ role: "user", content: opts.user }],
    };

    const t0 = Date.now();
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `anthropic provider: network failure (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `anthropic provider: HTTP ${res.status} (${text.slice(0, 200)})`,
      );
    }
    const json = (await res.json()) as AnthropicResponse;
    const content = json.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const inputTokens = json.usage.input_tokens;
    const outputTokens = json.usage.output_tokens;
    return {
      content,
      inputTokens,
      outputTokens,
      costUsd: estimateCostUsd(json.model, inputTokens, outputTokens),
      latencyMs,
      modelEcho: json.model,
    };
  },
};
