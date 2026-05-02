import { describe, it, expect } from "vitest";
import { estimateCostUsd, PRICING } from "../../../src/rca/llm/provider.js";

describe("estimateCostUsd", () => {
  it("computes cost for a known model from the pricing table", () => {
    // sonnet-4-6: $3/M input, $15/M output
    const cost = estimateCostUsd("claude-sonnet-4-6", 100_000, 50_000);
    // 100k * 3/M = 0.30; 50k * 15/M = 0.75; total 1.05
    expect(cost).toBeCloseTo(1.05, 5);
  });

  it("returns 0 for an unknown model rather than guessing", () => {
    expect(estimateCostUsd("claude-future-model", 1000, 1000)).toBe(0);
  });

  it("scales linearly with token count", () => {
    const a = estimateCostUsd("gpt-4o-mini", 1000, 0);
    const b = estimateCostUsd("gpt-4o-mini", 2000, 0);
    expect(b).toBeCloseTo(2 * a, 8);
  });
});

describe("PRICING table", () => {
  it("ships rows for the documented default models", () => {
    expect(PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(PRICING["claude-haiku-4-5-20251001"]).toBeDefined();
    expect(PRICING["gpt-4o-mini"]).toBeDefined();
  });

  it("input price <= output price for every model (non-controversial sanity)", () => {
    for (const [model, row] of Object.entries(PRICING)) {
      expect(row.outputPerMillion).toBeGreaterThanOrEqual(row.inputPerMillion);
      expect(row.inputPerMillion, `model ${model}`).toBeGreaterThan(0);
    }
  });
});
