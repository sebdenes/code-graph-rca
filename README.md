<div align="center">

# 🌟 Halo

**RCA infrastructure for AI-built code.** Lights up the bug.

A code knowledge graph + opinionated RCA engine + visual graph explorer, designed for the world where most code is written with AI assistance and the bugs the agent ships are bugs the agent has to debug.

[![npm version](https://img.shields.io/npm/v/code-graph-rca.svg?label=core&style=flat-square)](https://www.npmjs.com/package/code-graph-rca)
[![ui version](https://img.shields.io/npm/v/code-graph-rca-ui.svg?label=ui&style=flat-square)](https://www.npmjs.com/package/code-graph-rca-ui)
[![github-app version](https://img.shields.io/npm/v/code-graph-rca-github-app.svg?label=github-app&style=flat-square)](https://www.npmjs.com/package/code-graph-rca-github-app)
[![CI](https://img.shields.io/github/actions/workflow/status/sebdenes/code-graph-rca/cgrca.yml?branch=main&label=cgrca%20PR%20review&style=flat-square)](https://github.com/sebdenes/code-graph-rca/actions/workflows/cgrca.yml)
[![license](https://img.shields.io/npm/l/code-graph-rca.svg?style=flat-square)](LICENSE)
[![node](https://img.shields.io/node/v/code-graph-rca.svg?style=flat-square)](https://nodejs.org)

</div>

> **Heads up on the brand.** The product is *Halo*. The npm packages and CLI are still `code-graph-rca` / `code-graph-rca-ui` / `code-graph-rca-github-app` and the binaries are `cgrca`, `cgrca-view`, `cgrca-pr-review` — those names are stable. The README and marketing use *Halo* as the display name.

---

## What it is

When an AI agent investigates a bug it reads files one at a time and infers structure from filenames and imports. It misses dependencies, breaking changes, and the actual call site of the failure. Its fixes introduce new bugs because it can't see the blast radius.

Halo fixes that. Given a failure — a stack trace, a failing test, a symbol, a file — it walks outward from the failure scope, indexes just those files with [tree-sitter](https://tree-sitter.github.io/) into in-memory SQLite, then exposes structural facts via:

- **An MCP server** any MCP-aware agent (Cursor, Claude Code, Cody, Cline, Continue, Windsurf, Zed) speaks natively
- **A CLI** for direct use, CI integration, scripting
- **A web UI** (the *Constellation*) for visual exploration of the graph

It's session-scoped — built fresh for each invocation, discarded when done. No daemon. No persistent index. No staleness. The graph is small because the failure neighborhood is small.

## Why Halo is distinct

| | Generic graph indexer | Halo |
|---|---|---|
| Scope | full repo | failure-scoped (5–10k LOC) |
| Index time | minutes, then maintained | <1s, fresh each invocation |
| Edge confidence | binary | graded (1.0 / 0.7 / 0.5) |
| Unresolved targets | dropped | preserved as grep-bait for the LLM |
| Recency signal | separate query | attached as node metadata |
| Output | raw graph | ranked **causal candidates** + first hypothesis |
| Distribution | tool-specific | MCP (cross-vendor), CLI, web UI |

The killer feature is the **causal chain**: nodes are ranked by `recency × proximity × ambiguity × co-change × subsystem`, surfaced as a structured shortlist the LLM picks the root cause from — instead of reasoning over raw graph edges.

## Install

```sh
npm install -g code-graph-rca code-graph-rca-ui
cd /path/to/your/repo
cgrca init
```

`cgrca init` detects your editor (Cursor, Claude Code, Cline, Continue, Windsurf), registers cgrca's MCP server, and drops `AGENTS.md` at the repo root teaching the agent when to call which tool. Restart the editor and the agent has eight new tools.

## The eight MCP tools

| Tool | What it does |
|---|---|
| `cgrca_rcaPrompt` | Full grounded RCA prompt: ranked candidates, first hypothesis, graph context, the seven-step protocol. Drop straight into reasoning. |
| `cgrca_rca` | Same as above, structured JSON. |
| `cgrca_definitionOf` | Find every declaration of a symbol — file, line range, signature, exported, language, subsystem. |
| `cgrca_callersOf` | Reverse call tree, depth 1–5, confidence-weighted, deduped by `(file, name)`. |
| `cgrca_calleesOf` | Forward call tree, depth 1–4. Unresolved targets surface with `resolved: false` + `to_name` preserved. |
| `cgrca_symbolsInFile` | Every symbol in a file, in source order. |
| `cgrca_recentlyChangedNear` | `git log -L` for a symbol's lines. Most root causes are recent changes. |
| `cgrca_scope` | Dry-run preview of the file set cgrca would index for a given failure. |

## CLI

```sh
# Run RCA, print the prompt
cgrca rca symbol:login --repo /path/to/repo

# Save the graph as a SQLite file you can re-open later
cgrca rca symbol:login --repo /path/to/repo --persist /tmp/x.sqlite

# Surgical lookups
cgrca define login --repo /path/to/repo
cgrca callers login --repo /path/to/repo -d 3
cgrca callees login --repo /path/to/repo
cgrca changed login --repo /path/to/repo --since 30
```

## The Constellation graph view

The companion UI ships `cgrca-view` — a visual explorer for the indexed graph plus the ranked candidates plus the impact analysis.

```sh
cgrca rca symbol:login --persist /tmp/x.sqlite --repo /path/to/repo
cgrca-view /tmp/x.sqlite
```

Three views, one substrate:

- **Graph (Constellation)** — Dense organic cloud of compact labeled nodes via cose-bilkent. Click any node to slide in a Monaco panel with the source. Causal halos glow red around bug suspects; recency rings encode 7d / 30d / 90d age.
- **RCA** — Ranked causal candidates panel (left), failure call neighborhood (center), per-node detail (right). Score breakdown by signal: recency × proximity × ambiguity × co-change × subsystem.
- **Impact** — "If I change X, what breaks?" Forward propagation tree, hop-grouped graph, ranked-by-risk table, "high blast radius" banner.
- **Inspector pane** — Click a graph node → Monaco editor slides in with the file at the symbol's start line. Multi-tab (LRU cap 6). Breadcrumb: `subsystem · file · parent_class · symbol_name`.

### See it on a real PR

The live demo of the GitHub Action path is the cgrca repo's own first PR — the bot found a real bug in itself (a duplicate listing in the "top untested callers" output). The fix shipped in v0.3.1; the bot reviewed its own fix on PR #2.

- **PR #1** (bot's first self-review, found the bug): https://github.com/sebdenes/code-graph-rca/pull/1
- **PR #2** (bot reviewed its own fix, confirmed clean output): https://github.com/sebdenes/code-graph-rca/pull/2

> Screenshots of the Constellation viewer are coming. In the meantime: clone, run `cgrca init`, generate a session with `cgrca rca symbol:foo --persist /tmp/x.sqlite`, then `cgrca-view /tmp/x.sqlite` opens the viewer in your browser. Takes 90 seconds.

## Architecture

```
   ┌──────────────────────────────────────────────────────────────────┐
   │                       Failure (input)                            │
   │      stack trace · failing test · symbol · file path             │
   └──────────────────────────────┬───────────────────────────────────┘
                                  ▼
                    ┌─────────────────────────────┐
                    │  Scope walker (lexical)     │
                    │  bounded BFS over imports   │
                    │  + reverse callers          │
                    └─────────────┬───────────────┘
                                  ▼
                    ┌─────────────────────────────┐
                    │  Two-pass tree-sitter index │
                    │  pass 1: per-file extract   │
                    │  pass 2: cross-file resolve │
                    └─────────────┬───────────────┘
                                  ▼
                    ┌─────────────────────────────┐
                    │  In-memory SQLite           │
                    │  files / symbols / edges /  │
                    │  imports                    │
                    └─────────────┬───────────────┘
                                  ▼
   ┌────────────────┬─────────────┴────────────┬────────────────┐
   ▼                ▼                          ▼                ▼
 Queries          Recency hydrator         Causal scorer     Impact analysis
 (5 typed APIs)   (git log -L per node)    (ranked top-5)    (forward + risk)
                                  │
                                  ▼
                    ┌─────────────────────────────┐
                    │  Opinionated RCA prompt     │
                    │  failure → candidates →     │
                    │  hypothesis → graph →       │
                    │  protocol                   │
                    └─────────────┬───────────────┘
                                  ▼
   ┌──────────────────────────────┴──────────────────────────────────┐
   ▼                                                                  ▼
 MCP server (stdio)                                          Constellation UI
 cross-editor surface                                        visual exploration
```

## Languages

TypeScript family — `.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs`
Python — `.py/.pyi`

Other extensions are recorded as `unparsed` so the file tree stays complete.

## Honest fallbacks (v1)

cgrca prefers honest fallbacks to silent guesses. Every edge carries a confidence: `1.0` resolved exactly, `0.7` ambiguous receiver (e.g. `self.foo()` with multiple matches), `0.5` unresolved. Unresolved targets keep their `to_name` — that's grep-bait for the LLM.

Stubbed by design:

- TypeScript path aliases (`tsconfig.json` `paths`) are not resolved.
- Re-exports (`export * from`, `export { y } from`) are not followed past the barrel.
- `self`/`this` method dispatch uses a conservative heuristic: 1.0 single match in the parent class, 0.7 if multiple matches by name, 0.5 unresolved.
- Namespace-member calls (`mod.fn()` after `import * as mod`) are captured but not cross-resolved.
- Python star imports (`from m import *`) are recorded but skipped during resolution.

## Performance

Measured against a real codebase (athlai, ~17k files):

| Operation | Time |
|---|---|
| Scope-then-index for `bot.py` | **616 ms** (25 files, 1101 symbols, 3214 edges) |
| 5 query functions on indexed scope | <50 ms each |
| `recentlyChangedNear` (git log -L) | <500 ms per symbol |
| Full repo index (whole athlai) | 18.5 s (6903 files, 27928 symbols, 93087 edges) |
| Constellation initial render (cose-bilkent layout) | <1 s for 400 nodes / 2500 edges |

## Repo layout

```
code-graph-rca/
├── packages/
│   ├── core/                     code-graph-rca on npm
│   │   ├── src/
│   │   │   ├── graph/            walker, tree-sitter, queries, schema
│   │   │   ├── rca/              runner, scorer, prompt, recency hydrator
│   │   │   ├── mcp/              MCP server
│   │   │   ├── init/             cgrca init detection + AGENTS.md
│   │   │   └── cli.ts
│   │   └── test/
│   └── ui/                       code-graph-rca-ui on npm
│       ├── shared/               API contract types
│       ├── server/               Fastify backend (8 endpoints)
│       └── web/                  Vite + React + Cytoscape + Monaco
├── docs/
│   ├── ARCHITECTURE.md           architectural decisions in detail
│   ├── EXTENDING.md              how to add a language
│   └── RCA_PROTOCOL.md           the seven-step protocol the prompt embeds
└── README.md                     this file
```

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the scope-then-index bet, schema, two-pass design, honest fallbacks
- **[docs/RCA_PROTOCOL.md](docs/RCA_PROTOCOL.md)** — the seven-step protocol embedded in every cgrca prompt
- **[docs/EXTENDING.md](docs/EXTENDING.md)** — adding a language (one section, concrete steps)
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — project layout, tests, coding standards
- **[packages/core/README.md](packages/core/README.md)** — engine details, all CLI flags
- **[packages/ui/README.md](packages/ui/README.md)** — viewer details

## Status

**v0.2.0 shipped.** 58 tests across the workspace (44 core, 14 UI server). Real-world dog-food: surfaced two bugs in cgrca's own scope walker (NodeNext extension stripping + reverse-import regex flush) by being run against itself.

## License

MIT.
