# Architecture

This document describes the design of `code-graph-rca` and the choices that shape it.

## What this is

`cgrca` is **RCA infrastructure for AI-built code** — code knowledge graph + opinionated RCA engine + visual graph explorer, designed for the world where most code is written with AI assistance and the bugs the agent ships are bugs the agent has to debug.

It is not a one-tool-one-job utility. It is a substrate with three deliberate distribution surfaces, each addressing a different point in the AI-coding pipeline:

1. **An MCP server** — every MCP-aware agent (Cursor, Claude Code, Cody, Cline, Continue, Windsurf, Zed) speaks it natively. One server, every editor, no per-vendor adapter. MCP is the cross-vendor open standard; cgrca's primary surface area is here.
2. **A CLI** — for direct use, CI integration, scripting, and as the engine the MCP server fronts.
3. **A web UI** (the *Constellation*) — for visual exploration of the indexed graph, the ranked causal candidates, and the impact analysis. Standalone product, useful even when no agent is in the loop.

The core engine is RCA-centric, but RCA is the wedge — the same graph and queries are equally good for code review (impact analysis on a PR), for "what calls this" reasoning during refactors, and for grounding any agent's structural claims about a codebase. The MCP surface makes those uses available across the whole AI-coding ecosystem from a single install.

Every design decision below is judged against this broader role, not against narrow code search.

## The scope-then-index bet

Most code-intelligence tools index the whole repository, persist the index, and keep it warm. That is the right choice for "answer arbitrary questions across the codebase forever." It is the wrong choice for RCA, where the agent already has a starting point — a stack trace, a failing test, a symbol name, a file path — and the question is local.

`cgrca` flips the order. `resolveScope` (in `src/graph/scope.ts`) takes a `FailureScope` and produces a small set of seed files, then expands by following imports up to a configurable depth (default 2) and pulling in callers that import the seeds. Expansion stops at a budget: 200 files or 20,000 lines, whichever hits first. When the budget caps the scope, the result records that in a `notes` field. The agent sees what was included and what was left out.

The bet: almost every RCA conversation only needs a few hundred files of context, and paying parser cost on those at session start is cheaper — in time and tokens — than maintaining a persistent index of the whole repo.

## Two-pass indexing

`indexScope` (in `src/graph/orchestrator.ts`) runs in two passes. Pass one walks the resolved scope, parses each TS or Python file with web-tree-sitter, and uses the `.scm` queries to extract symbols, edges, and imports into a typed `ExtractedFile`. Call edges land with `to_symbol_id = NULL` — pass one does not try to resolve them. Files that don't match a known language extension are recorded as `unparsed` so they still count toward the scope.

Pass two is `resolveEdges` (in `src/graph/resolve.ts`). It runs over the populated database in three stages:

1. **Same-file resolution.** If a call's target name matches exactly one symbol in the same file, link it.
2. **`self`/`this` method resolution.** For calls inside methods whose enclosing class has exactly one method by that name, link with confidence 1.0. If the parent class has zero matches but the project-wide search finds exactly one method with that name, link with confidence 0.7 (ambiguous). Otherwise leave unresolved.
3. **Cross-file via imports.** For each unresolved edge, look up the calling file's imports for a binding that matches the target name, resolve the import to a target file (relative path for TS/Python, workspace-package lookup for TS, package-root lookup for Python), and bind to the matching top-level symbol.

Anything still unresolved has its confidence reduced from 1.0 to 0.5. Unresolved edges are kept, not dropped — the agent should see "we know this call exists, we don't know where it lands."

## The schema

Four tables, defined in `src/graph/schema.sql`:

- `files (id, path, language, subsystem, loc)`
- `symbols (id, file_id, name, kind, parent_id, start_line, end_line, signature, exported)`
- `edges (id, from_symbol_id, to_symbol_id, to_name, kind, confidence, call_line)`
- `imports (id, file_id, local_name, source_module, source_name, kind)`

Subsystem is derived by walking up to the nearest `package.json` with a `name` field (for TS monorepos) or `pyproject.toml` `[project].name` (for Python), falling back to the top-level directory. Symbols carry an `exported` flag the parser sets when an `export_statement` (TS) wraps the declaration. Edges always store `to_name` so unresolved calls remain queryable by name; `to_symbol_id` is populated when resolution succeeds.

## Honest fallbacks over silent failure

The resolver is deliberately conservative. It does not chase re-exports, follow barrel files, or honor `tsconfig.json` path aliases. When it cannot prove a target, it leaves the edge unresolved with reduced confidence and lets the query layer surface that. The governing phrase: an unresolved edge with `confidence=0.5` and `resolved=false` is more useful to a debugging agent than a silently-dropped edge or a confidently-wrong target.

Scope resolution follows the same rule. If a stack trace yields no in-repo frames, `notes` says so. If the budget caps expansion, the cap is named.

## The five queries

The query surface is intentionally small. Each query in `src/graph/queries.ts` returns a typed result, never a raw row.

- `definitionOf(name, opts?)` — every declaration matching the name, optionally filtered by language or subsystem, exported declarations first.
- `callersOf(name, { depth, minConfidence })` — reverse call tree. Depth clamps to `[1, 5]`; default 2. Results are deduped by `(file, name)` and merged across multiple definition sites of the same name.
- `calleesOf(name, { depth })` — forward call tree. Depth clamps to `[1, 4]`; default 1. Unresolved targets surface with `resolved=false`.
- `symbolsInFile(path)` — every symbol declared in a file, source order.
- `recentlyChangedNear(name, { sinceDays, repoRoot, maxCommits })` — `git log -L<start>,<end>:<file>` for each definition site (capped at 5), merged and date-sorted.

Five queries is enough for the protocol described in `RCA_PROTOCOL.md`. More queries would let agents explore more, which is exactly what we are trying not to do.

## What we don't ship

Three things are missing on purpose.

**No MCP server.** The tool is a library plus a CLI that emits a structured prompt. The agent calling `cgrca rca` already has tool-use; we don't need another transport layer. If a future deployment wants MCP, it can wrap the library.

**No persistence.** The default database is in-memory. `indexScope` accepts a `persist` path for debugging, but session-scoped is the design. A persisted graph needs invalidation, which means watching the filesystem, which means a daemon — at which point we are no longer the same product.

**No incremental indexing.** Every `cgrca rca` invocation re-resolves the scope and re-parses. The scope is small enough that this is fine. If indexing a 200-file scope ever takes more than a few seconds, that is a parser problem, not a caching problem.

These omissions are not "todo items." They are the shape of the tool.
