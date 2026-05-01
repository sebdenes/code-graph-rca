/**
 * Generates the AGENTS.md content dropped into a repo by `cgrca init`.
 *
 * AGENTS.md is the open, editor-agnostic file most modern coding agents
 * (Cursor, Claude Code, Codex, Aider, etc.) read on session start to
 * pick up project context. We use it to teach the agent when and how
 * to call cgrca's MCP tools.
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
  return `# AGENTS.md

This repo ships with **cgrca** — a code knowledge graph plus an RCA
engine. Use it whenever you investigate a bug, plan a fix, or estimate
the blast radius of a change.

## When to use cgrca

- **Bug investigation.** Before reading code, call \`cgrca_rcaPrompt\`
  with the failure (a stack trace, a failing test path, a symbol name,
  or a file path). It returns a structured prompt with ranked causal
  candidates, a first-hypothesis sentence, the graph context, and the
  seven-step RCA protocol. Treat that prompt as your primary substrate.
- **"What calls this?" / "What does this call?"** Use \`cgrca_callersOf\`
  and \`cgrca_calleesOf\` instead of grep when you want a typed,
  confidence-weighted answer.
- **Before changing a function signature.** Use \`cgrca_callersOf\` at
  depth 3 to enumerate every caller. Test coverage and risk show up
  via \`cgrca_recentlyChangedNear\` and the unresolved-call hints in
  the result.
- **Cross-file reasoning.** Use \`cgrca_definitionOf\` to find every
  declaration of a symbol — language and subsystem filters available.

## Tools

- \`cgrca_rca\` — full RCA, returns ranked candidates JSON.
- \`cgrca_rcaPrompt\` — same, returns ONLY the assembled prompt as text.
- \`cgrca_definitionOf\` — find symbol declarations.
- \`cgrca_callersOf\` — reverse call tree (depth 1–5, default 2).
- \`cgrca_calleesOf\` — forward call tree (depth 1–4, default 1).
- \`cgrca_symbolsInFile\` — every symbol in a file, source order.
- \`cgrca_recentlyChangedNear\` — git log -L for a symbol's lines.
- \`cgrca_scope\` — dry-run preview of which files cgrca would index.

## Honest fallbacks

cgrca returns confidence-graded edges. **Confidence 1.0** means resolved
exactly. **0.7** means the receiver type was ambiguous (e.g. \`self.foo()\`
with multiple possible matches). **0.5** means unresolved — the call
target is dynamic, a builtin, or a module we couldn't trace. Unresolved
edges still carry the \`to_name\` — that's grep-bait for you. Don't drop
them; they're often the most informative part of the graph.

## Project notes

- Repo: \`${repoName}\`
- For visual exploration of the graph, run \`cgrca-view\` (the web UI)
  pointed at a session \`.sqlite\` written by \`cgrca rca --persist <path>\`.
- The RCA protocol is enforced — don't band-aid the symptom; verify the
  hypothesis before fixing.
`;
}
