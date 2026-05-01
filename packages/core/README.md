# code-graph-rca

RCA-specific code knowledge graph for AI coding agents. Session-scoped, in-memory, opinionated.

When an AI agent investigates a bug, it reads files one at a time and infers structure from filenames and imports. It misses dependencies, breaking changes, and the actual call site of the failure. cgrca fixes that. Given a failure (a stack trace, a failing test, a symbol, or a file), it walks outward to a bounded scope, parses just those files with tree-sitter into in-memory SQLite, and exposes structural facts the agent can reason against.

## Install

```sh
npm install -g code-graph-rca
cgrca init               # detects your editor, registers cgrca's MCP server, drops AGENTS.md
```

That's it. Restart your editor (Cursor, Claude Code, Cline, Continue, Windsurf — anything MCP-aware) and the agent has eight new tools:

- `cgrca_rcaPrompt` — full grounded RCA prompt: ranked candidates, first hypothesis, graph context, the seven-step protocol.
- `cgrca_rca` — same, structured JSON.
- `cgrca_definitionOf` — find symbol declarations.
- `cgrca_callersOf` — reverse call tree, depth 1–5.
- `cgrca_calleesOf` — forward call tree.
- `cgrca_symbolsInFile` — every symbol in a file.
- `cgrca_recentlyChangedNear` — `git log -L` for a symbol's lines.
- `cgrca_scope` — dry-run preview of which files cgrca would index.

## Direct CLI

```sh
cgrca rca symbol:login --repo /path/to/repo            # human prompt
cgrca rca symbol:login --repo /path/to/repo --json     # structured RcaResult
cgrca rca <stack-trace-file> --repo /path/to/repo --persist /tmp/x.sqlite   # save the graph
cgrca define login --repo /path/to/repo                # definitionOf
cgrca callers login --repo /path/to/repo -d 3          # callersOf
cgrca callees login --repo /path/to/repo               # calleesOf
cgrca changed login --repo /path/to/repo --since 30    # recentlyChangedNear
```

## What's distinct

- **Scope-then-index.** Most bugs touch a few thousand lines. Indexing 5–10k LOC of relevant scope takes <1s with tree-sitter WASM and in-memory SQLite. Removes every staleness, sync, and incremental-update headache.
- **Causal chain ranking.** Recency × proximity × ambiguity × co-change × subsystem. Top candidate is the most likely root-cause site, not just the closest node in the graph.
- **Confidence-graded edges with names always preserved.** 1.0 resolved exactly, 0.7 ambiguous receiver, 0.5 unresolved. The `to_name` survives even when the target is dynamic — that's grep-bait for the agent.
- **Recent-change blame integrated.** Per-symbol `git log -L` attached to each graph node. Most root causes are recent changes.
- **Opinionated RCA prompt, not just a query API.** Failure context → ranked candidates → first hypothesis → graph context → §10 protocol. Drop into any agent loop.

## Languages

TypeScript family (`.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs`) and Python (`.py/.pyi`). Other extensions are recorded as `unparsed` so the file tree stays complete.

## Limitations (v1)

Stubbed by design — honest fallbacks over silent guesses:

- TypeScript path aliases (`tsconfig.json` `paths`) are not resolved.
- Re-exports (`export * from`, `export { y } from`) are not followed past the barrel.
- `self`/`this` method dispatch uses a conservative heuristic (1.0 single match, 0.7 multi, 0.5 unresolved).
- Namespace-member calls (`mod.fn()` after `import * as mod`) are captured but not cross-resolved.

## Visual exploration

The companion package [`code-graph-rca-ui`](https://www.npmjs.com/package/code-graph-rca-ui) ships `cgrca-view` — a Constellation-style force-directed graph view + Monaco code inspector + RCA & impact tabs.

```sh
npm install -g code-graph-rca-ui
cgrca rca symbol:bug --persist /tmp/x.sqlite --repo .
cgrca-view /tmp/x.sqlite                                   # opens browser
```

## License

MIT.
