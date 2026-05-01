export type FailureScope =
  | { kind: "stack-trace"; text: string }
  | { kind: "failing-test"; path: string; testName?: string }
  | { kind: "symbol"; name: string; file?: string }
  | { kind: "file"; path: string };

export const RCA_PROTOCOL = `When something does not work — a test fails, a parse errors, a query returns wrong results, a runtime exception fires — do not patch the symptom. Follow this protocol:

1. **Reproduce** the failure deterministically. If it is intermittent, find what makes it intermittent before going further.
2. **State the observed behavior** in one sentence. State the expected behavior in one sentence. The gap between them is the bug.
3. **Hypothesize the root cause.** A root cause is the *first* link in the causal chain that, if changed, makes the failure not occur. Surface symptoms (a wrong value, a missing edge, a thrown exception) are not root causes — they are evidence.
4. **Verify the hypothesis** before fixing. Add a log, a test, an assertion that distinguishes "hypothesis correct" from "hypothesis incorrect." If the verification fails, the hypothesis was wrong — go back to step 3 with the new evidence.
5. **Fix the root cause, not the symptom.** A fix that makes the failing test pass without addressing the verified root cause is a band-aid. Reject it, even if it is faster.
6. **Add a regression test** that would have caught this bug. The test belongs in the same commit as the fix.
7. **Document** what changed, why, and what alternatives were considered, in the commit message.

Band-aid fixes are forbidden. If the root cause is genuinely out of scope for the current change, write a failing test that pins the bug, mark it skipped with a comment explaining why, and open an issue. Do not silently work around it.`;

function renderFailure(failure: FailureScope): string {
  switch (failure.kind) {
    case "stack-trace":
      return "```\n" + failure.text + "\n```";
    case "failing-test": {
      const lines = [`Failing test: ${failure.path}`];
      if (failure.testName !== undefined) lines.push(`Test name: ${failure.testName}`);
      return lines.join("\n");
    }
    case "symbol": {
      const lines = [`Investigating symbol: ${failure.name}`];
      if (failure.file !== undefined) lines.push(`File: ${failure.file}`);
      return lines.join("\n");
    }
    case "file":
      return `Investigating file: ${failure.path}`;
  }
}

export function buildPrompt(args: {
  failure: FailureScope;
  graphContext: string;
  causalSection: string;
  firstHypothesis: string | null;
}): string {
  const failureSection = `# Failure context\n\n${renderFailure(args.failure)}`;
  const hypothesisBody =
    args.firstHypothesis !== null ? args.firstHypothesis : "_(no candidates)_";
  const hypothesisSection = `## First hypothesis\n\n${hypothesisBody}`;
  const protocolSection = `# Root-cause-analysis protocol\n\n${RCA_PROTOCOL}`;
  return [
    failureSection,
    args.causalSection,
    hypothesisSection,
    args.graphContext,
    protocolSection,
  ].join("\n\n---\n\n");
}
