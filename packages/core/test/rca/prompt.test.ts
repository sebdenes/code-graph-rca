import { describe, it, expect } from "vitest";
import { formatRcaPrompt, type PromptInput } from "../../src/rca/prompt.js";
import type { CausalCandidate } from "../../src/types.js";

function makeCandidate(overrides: Partial<CausalCandidate>): CausalCandidate {
  return {
    name: "doThing",
    file: "src/foo.ts",
    line: 10,
    kind: "function",
    loc: 12,
    subsystem: "core",
    role: "callee",
    distance: 1,
    score: 4.2,
    signals: {
      recencyScore: 1,
      proximityScore: 1,
      ambiguityScore: 0.5,
      coChangeScore: 0,
      subsystemScore: 0,
      complexityScore: 0,
      dataflowScore: 1.5,
    },
    rationale: "edited recently and called directly from anchor",
    recentChanges: [],
    unresolvedCallTargets: [],
    ...overrides,
  };
}

const FIXTURE: PromptInput = {
  failure: { kind: "symbol", name: "login", file: "packages/auth/src/login.ts" },
  scope: {
    files: ["packages/auth/src/login.ts", "packages/auth/src/hash.ts"],
    symbolCount: 7,
    edgeCount: 11,
  },
  causalCandidates: [
    makeCandidate({ name: "verifyHash", file: "packages/auth/src/hash.ts", line: 22, score: 5.7 }),
    makeCandidate({ name: "loadSession", file: "packages/auth/src/session.ts", line: 4, score: 3.1, role: "caller" }),
  ],
  firstHypothesis:
    "The root cause is most likely in verifyHash (packages/auth/src/hash.ts:22) — edited recently and called directly from anchor",
  queries: [
    { name: "definitionOf", result: [{ name: "login", file: "packages/auth/src/login.ts" }] },
    { name: "callersOf", result: { target: "login", callers: [] } },
    { name: "calleesOf", result: { source: "login", callees: [{ name: "verifyHash" }] } },
  ],
  primarySymbol: "login",
};

describe("formatRcaPrompt", () => {
  it("emits the canonical section headings in order", () => {
    const out = formatRcaPrompt(FIXTURE);
    const idxFailure = out.indexOf("# Failure context");
    const idxCandidates = out.indexOf("## Top causal candidates");
    const idxHypothesis = out.indexOf("## First hypothesis");
    const idxGraph = out.indexOf("## Graph context");
    const idxProtocol = out.indexOf("# Root-cause-analysis protocol");
    expect(idxFailure).toBeGreaterThanOrEqual(0);
    expect(idxCandidates).toBeGreaterThan(idxFailure);
    expect(idxHypothesis).toBeGreaterThan(idxCandidates);
    expect(idxGraph).toBeGreaterThan(idxHypothesis);
    expect(idxProtocol).toBeGreaterThan(idxGraph);
  });

  it("renders candidates in the supplied order with their score and rationale", () => {
    const out = formatRcaPrompt(FIXTURE);
    const top = out.indexOf("verifyHash");
    const second = out.indexOf("loadSession");
    expect(top).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(top);
    expect(out).toContain("score 5.7");
    expect(out).toContain("score 3.1");
    expect(out).toContain("edited recently and called directly from anchor");
  });

  it("renders the failure-context body for each failure-kind shape", () => {
    expect(formatRcaPrompt({ ...FIXTURE, failure: { kind: "stack-trace", text: "TypeError: x is undefined" } }))
      .toContain("TypeError: x is undefined");
    expect(formatRcaPrompt({ ...FIXTURE, failure: { kind: "failing-test", path: "a.test.ts", testName: "t1" } }))
      .toContain("Failing test: a.test.ts");
    expect(formatRcaPrompt({ ...FIXTURE, failure: { kind: "file", path: "src/x.ts" } }))
      .toContain("Investigating file: src/x.ts");
  });

  it("falls back to a no-candidates message when the shortlist is empty", () => {
    const out = formatRcaPrompt({ ...FIXTURE, causalCandidates: [], firstHypothesis: null });
    expect(out).toContain("## Top causal candidates");
    expect(out).toContain("_(none");
    expect(out).toContain("## First hypothesis");
    expect(out).toContain("_(no candidates)_");
  });

  it("is a pure function — same input yields byte-identical output", () => {
    const a = formatRcaPrompt(FIXTURE);
    const b = formatRcaPrompt(FIXTURE);
    expect(a).toBe(b);
  });
});
