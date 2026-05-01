# RCA Protocol

This is the seven-step protocol the `cgrca rca` command embeds in the prompt it produces, and the one contributors should follow when fixing non-trivial bugs in this repo. It is written for an agent — human or LLM — that has a failure in hand and access to the five graph queries. Use it whenever the bug is not obvious from the failure alone. If the fix is one line and the root cause is staring at you, skip the protocol. The protocol exists for cases where the visible symptom is a few hops from the actual defect — where a confident-looking agent can otherwise produce a confident-looking fix that masks the problem. The graph queries keep each step grounded in code that ships, not code the model imagined.

## The seven steps

1. **Restate the failure precisely.** What is the observable symptom? What was the expected behavior? Quote the error, name the failing test, identify the entry point. If the failure description is vague, ask before guessing.

2. **Locate the symbol.** Use `definitionOf` on the name in the failure. If multiple definitions match, narrow by language, subsystem, or file path. Read the signature and line range. Confirm you are looking at the symbol that is actually invoked.

3. **Trace the call site.** Use `callersOf` (depth >= 2) to see who reaches this code, and `calleesOf` to see what it depends on. Note unresolved edges (`resolved=false`, `confidence=0.5`) — they are gaps in the graph, not gaps in the program, and you may need to read source to fill them in.

4. **Form a hypothesis.** One or two sentences. It must be falsifiable: it must predict something you can check. "The token rotation hook runs before the session commits, so a crash between them orphans the token" is a hypothesis. "There is a race condition" is not.

5. **Check recent changes.** Use `recentlyChangedNear` on the suspect symbol and its closest callers and callees. A bug that appeared after a known change is faster to root-cause. If the suspect has not changed in months, widen to its dependencies.

6. **Validate before fixing.** Reproduce the failure. Add a test that fails for the reason your hypothesis predicts, not just any test that fails. If it passes when you expected it to fail, the hypothesis is wrong — go back to step 4.

7. **Fix the root cause, not the symptom.** The fix should make the falsified test pass without try/catch swallowing, retry loops, or comments excusing the code. If the cleanest fix changes a contract other callers depend on, list those callers with `callersOf` and decide explicitly.

The commit message should name the root cause in one sentence. "Fix login bug" is not a root cause. "Commit session before issuing rotation token so a crash between them cannot orphan the token" is.
