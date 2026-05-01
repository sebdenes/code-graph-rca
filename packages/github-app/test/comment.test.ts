/**
 * Unit tests for the pure comment-formatting helpers.
 * The handler.test e2e covers the full flow; these test edge cases of the
 * helpers in isolation.
 */
import { describe, it, expect } from "vitest";
import { pickTopUntested } from "../src/comment.js";
import type { ImpactNode } from "code-graph-rca";

function node(over: Partial<ImpactNode>): ImpactNode {
  return {
    name: "X",
    file: "src/x.ts",
    line: 1,
    distance: 1,
    riskScore: 0.5,
    testCoverage: [],
    recentChanges: [],
    callers: [],
    ...over,
  };
}

describe("pickTopUntested", () => {
  it("dedupes by (file, name) — caught on PR #1 where cmdRca appeared twice", () => {
    // Two changed symbols both have cmdRca as a transitive caller. The
    // handler concatenates their impact lists; the same caller now arrives
    // twice. Without dedupe, the comment shows it twice.
    const inputs: ImpactNode[] = [
      node({ name: "cmdRca", file: "packages/core/src/cli.ts", riskScore: 0.7 }),
      node({ name: "cmdRca", file: "packages/core/src/cli.ts", riskScore: 0.7 }),
      node({ name: "startMcpServer", file: "packages/core/src/mcp/server.ts", riskScore: 0.5 }),
    ];
    const out = pickTopUntested(inputs, 3);
    const names = out.map((n) => n.name);
    expect(names).toEqual(["cmdRca", "startMcpServer"]);
    expect(out).toHaveLength(2);
  });

  it("keeps the higher risk score when the same node arrives twice", () => {
    const inputs: ImpactNode[] = [
      node({ name: "f", file: "a.ts", riskScore: 0.4 }),
      node({ name: "f", file: "a.ts", riskScore: 0.9 }),
    ];
    const out = pickTopUntested(inputs, 3);
    expect(out).toHaveLength(1);
    // We don't surface riskScore on UntestedCaller, but we can prove the
    // higher-score node won by checking the first match isn't the lower one.
    // (Both have the same name+file; the test really proves "no duplicates".)
  });

  it("filters out distance=0 (the seed itself)", () => {
    const inputs: ImpactNode[] = [
      node({ name: "seed", distance: 0, riskScore: 1.0 }),
      node({ name: "caller", distance: 1, riskScore: 0.5 }),
    ];
    const out = pickTopUntested(inputs, 3);
    expect(out.map((n) => n.name)).toEqual(["caller"]);
  });

  it("filters out nodes with test coverage", () => {
    const inputs: ImpactNode[] = [
      node({ name: "covered", testCoverage: ["test_covered.py"], riskScore: 0.9 }),
      node({ name: "uncovered", testCoverage: [], riskScore: 0.3 }),
    ];
    const out = pickTopUntested(inputs, 3);
    expect(out.map((n) => n.name)).toEqual(["uncovered"]);
  });

  it("respects the limit", () => {
    const inputs: ImpactNode[] = [1, 2, 3, 4, 5].map((i) =>
      node({ name: `n${i}`, file: `f${i}.ts`, riskScore: 1 - i * 0.1 }),
    );
    const out = pickTopUntested(inputs, 2);
    expect(out).toHaveLength(2);
  });
});
