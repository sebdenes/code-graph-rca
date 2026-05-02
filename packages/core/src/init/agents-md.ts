/**
 * Generates the AGENTS.md content dropped into a repo by `cgrca init`.
 *
 * AGENTS.md is the open, editor-agnostic file most modern coding agents
 * (Cursor, Claude Code, Codex, Aider, etc.) read on session start to
 * pick up project context. We use it to teach the agent when and how
 * to call Halo's MCP tools.
 *
 * Style: short, declarative, action-oriented. Every sentence either
 * tells the agent WHAT to do or gives one fact about the project.
 */

export interface AgentsMdOptions {
  /** Path to the cgrca CLI entry (used in the manual fallback example). */
  cliPath: string;
  /** Repo-relative pretty name for examples. */
  repoName: string;
}

export function renderAgentsMd(opts: AgentsMdOptions): string {
  const { repoName } = opts;
  return `# Halo · RCA tools for AI agents

This repo ships with **Halo** — a code knowledge graph + RCA engine
exposed over MCP. Use it whenever you investigate a bug, plan a fix,
or estimate the blast radius of a change.

## Budget

**Don't call more than 3 Halo tools per investigation.** The ranked
output of \`cgrca_rca\` already collapses what would otherwise be a
walk of callers / callees / changed / definitions. Start there.

## When to call which

1. **Bug investigation — start here.** Call \`cgrca_rca\` with the
   failure (stack trace, failing-test path, symbol, or file). It
   returns ranked causal candidates with role, location, and a
   one-line rationale. Read the top 3. If you need the full
   markdown grounding prompt instead of structured JSON, call
   \`cgrca_rcaPrompt\`.
2. **Targeted lookup — second pass.** Use \`cgrca_definitionOf\` to
   find every declaration of a symbol; \`cgrca_callersOf\` /
   \`cgrca_calleesOf\` for typed, confidence-weighted call trees;
   \`cgrca_recentlyChangedNear\` for git-log of a symbol's lines.
3. **Before a signature change.** \`cgrca_callersOf\` at depth 3
   enumerates every caller; the unresolved-call hints flag dynamic
   dispatch you can't see from grep.
4. **Sanity-check coverage.** \`cgrca_symbolsInFile\` lists every
   symbol Halo extracted from a file in source order — useful when
   you're not sure whether a function was indexed.

## Tools

- \`cgrca_rca\` — ranked causal candidates as structured JSON.
- \`cgrca_rcaPrompt\` — same, returns ONLY the assembled markdown prompt.
- \`cgrca_definitionOf\` — find symbol declarations.
- \`cgrca_callersOf\` — reverse call tree (depth 1–5, default 2).
- \`cgrca_calleesOf\` — forward call tree (depth 1–4, default 1).
- \`cgrca_symbolsInFile\` — every symbol in a file, source order.
- \`cgrca_recentlyChangedNear\` — git log -L for a symbol's lines.
- \`cgrca_currentSelection\` / \`cgrca_publishSelection\` — bridge to a
  running viewer; degrade to \`{ none: true }\` when no UI is up.

## Daemon

If \`cgrcad\` is running, queries are ~500x warm — they reuse a
persisted SQLite per repo, with fs-watch invalidation. Initialize
it once per session and forget about it:

\`\`\`sh
cgrca daemon start    # background; idempotent
cgrca daemon status   # check
\`\`\`

The MCP server transparently routes through the daemon when it's
up. No tool-call changes needed.

## Honest fallbacks

Halo returns confidence-graded edges. **1.0** = resolved exactly.
**0.7** = ambiguous receiver (e.g. \`self.foo()\` with multiple
matches). **0.5** = unresolved — call target is dynamic, builtin,
or untraced; the \`to_name\` is preserved as grep-bait. Don't drop
unresolved edges; they're often the most informative.

## Project notes

- Repo: \`${repoName}\`
- For visual exploration, run \`cgrca-view\` pointed at a session
  \`.sqlite\` written by \`cgrca rca --persist <path>\`.
- The RCA protocol is enforced — don't band-aid the symptom; verify
  the hypothesis before fixing.
`;
}
