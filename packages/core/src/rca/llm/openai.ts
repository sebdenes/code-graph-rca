import {
  estimateCostUsd,
  type LlmCallOpts,
  type LlmCallResult,
  type LlmProvider,
} from "./provider.js";

/**
 * OpenAI-compatible Chat Completions provider.
 * Auth: OPENAI_API_KEY (required) + OPENAI_BASE_URL (optional, defaults
 * to https://api.openai.com/v1). Use OPENAI_BASE_URL to point at
 * Together / Groq / a local llama.cpp server / etc — they all speak
 * the same chat-completions wire format.
 */

const DEFAULT_BASE = "https://api.openai.com/v1";

interface OpenAiResponse {
  id: string;
  model: string;
  choices: Array<{ index: number; message: { content: string | null; role: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export const openaiProvider: LlmProvider = {
  name: "openai",

  defaultModel(): string {
    return "gpt-4o-mini";
  },

  async call(opts: LlmCallOpts): Promise<LlmCallResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "openai provider: OPENAI_API_KEY is not set (required for --llm).",
      );
    }
    const base = (process.env.OPENAI_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
    const endpoint = `${base}/chat/completions`;

    // For json-shape, both append the instruction AND request response_format.
    // response_format may be ignored by non-OpenAI servers; the prompt hint is
    // the safety net.
    const system =
      opts.responseShape === "json"
        ? `${opts.system}\n\nRespond with valid JSON only. No prose, no code fences.`
        : opts.system;

    const body: Record<string, unknown> = {
      model: opts.model,
      max_tokens: opts.maxOutputTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: opts.user },
      ],
    };
    if (opts.responseShape === "json") {
      body.response_format = { type: "json_object" };
    }

    const t0 = Date.now();
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `openai provider: network failure (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `openai provider: HTTP ${res.status} (${text.slice(0, 200)})`,
      );
    }
    const json = (await res.json()) as OpenAiResponse;
    const content = json.choices[0]?.message.content ?? "";
    const inputTokens = json.usage.prompt_tokens;
    const outputTokens = json.usage.completion_tokens;
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
