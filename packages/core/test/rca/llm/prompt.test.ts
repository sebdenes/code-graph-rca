import { describe, it, expect } from "vitest";
import {
  approxTokens,
  renderUserPrompt,
  SYSTEM_PROMPT,
  type CandidateBundle,
} from "../../../src/rca/llm/prompt.js";
import type { CausalCandidate } from "../../../src/types.js";

function fakeCandidate(over: Partial<CausalCandidate> = {}): CausalCandidate {
  return {
    name: "do_thing",
    file: "core/foo.py",
    line: 42,
    kind: "function",
    loc: 12,
    subsystem: "core",
    role: "anchor",
    distance: 0,
    score: 0.7,
    signals: {
      recencyScore: 0.3,
      proximityScore: 0.5,
      ambiguityScore: 0.0,
      coChangeScore: 0.0,
      subsystemScore: 0.5,
      complexityScore: 0.4,
      dataflowScore: 0.0,
    },
    rationale: "anchor itself; ranked by static signals",
    recentChanges: [],
    unresolvedCallTargets: [],
    ...over,
  };
}

describe("renderUserPrompt", () => {
  it("includes the failure description verbatim and one section per candidate", () => {
    const bundles: CandidateBundle[] = [
      {
        rank: 1,
        candidate: fakeCandidate(),
        body: { body: "def do_thing():\n    pass", startLine: 42, endLine: 43, truncated: false, language: "python" },
        callers: ["caller_a (bar.py:10)"],
        callees: [],
      },
      {
        rank: 2,
        candidate: fakeCandidate({ name: "other", file: "core/bar.py", line: 100, role: "caller", score: 0.5 }),
        body: null,
        callers: [],
        callees: ["sub_thing (bar.py:120)"],
      },
    ];
    const out = renderUserPrompt("Cyclists silently get marathon plans.", bundles);
    expect(out).toContain("## Failure");
    expect(out).toContain("Cyclists silently get marathon plans.");
    expect(out).toMatch(/### Candidate 1/);
    expect(out).toMatch(/### Candidate 2/);
    expect(out).toContain("def do_thing():");
    expect(out).toContain("Body: (source not available)");
    expect(out).toContain("Callers: caller_a (bar.py:10)");
    expect(out).toContain("Callees: sub_thing (bar.py:120)");
    // JSON schema block must be present so the LLM has the contract.
    expect(out).toMatch(/Respond as JSON only/);
    expect(out).toContain('"rootCause"');
  });

  it("collapses multi-line rationale into one prompt line", () => {
    const bundles: CandidateBundle[] = [
      {
        rank: 1,
        candidate: fakeCandidate({ rationale: "line one\nline two\n   line three" }),
        body: null,
        callers: [],
        callees: [],
      },
    ];
    const out = renderUserPrompt("desc", bundles);
    expect(out).toContain("Why ranked here: line one line two line three");
    expect(out).not.toContain("Why ranked here: line one\n");
  });

  it("flags truncated body in the prompt so the LLM knows it didn't see all", () => {
    const bundles: CandidateBundle[] = [
      {
        rank: 1,
        candidate: fakeCandidate(),
        body: { body: "L1\nL2\nL3", startLine: 10, endLine: 12, truncated: true, language: "python" },
        callers: [],
        callees: [],
      },
    ];
    const out = renderUserPrompt("desc", bundles);
    expect(out).toContain("(body truncated;");
  });
});

describe("approxTokens", () => {
  it("approximates ~4 chars per token", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("a".repeat(40))).toBe(10);
    expect(approxTokens("hello world!")).toBeGreaterThan(0);
  });
});

describe("SYSTEM_PROMPT", () => {
  it("instructs the model not to invent files outside the candidate set", () => {
    expect(SYSTEM_PROMPT).toMatch(/do not invent file paths/i);
  });
  it("calls out honest confidence (no anchoring at 0.7)", () => {
    expect(SYSTEM_PROMPT).toMatch(/0\.7/);
  });
});
