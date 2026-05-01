# code-graph-rca

A code knowledge graph built for one job: helping an AI coding agent do root-cause analysis on a specific bug. Instead of indexing the whole repo, `cgrca` resolves a small *scope* from a failure (stack trace, failing test, symbol, or file), parses those files plus their close neighbors with tree-sitter, loads the result into in-memory SQLite, and exposes five typed queries. No daemon, no persisted index, no MCP server. The graph lives for one debugging session.

## Install

```sh
npm install code-graph-rca
npm run build
```

Requires Node 20+. The build step is needed until the first public release ships prebuilt artifacts.

## Quickstart

The `cgrca rca` command resolves a scope around a failure, indexes it, and prints a structured prompt — failure context, graph context, and the RCA protocol — ready to feed to an LLM.

```sh
npx cgrca rca symbol:login --repo path/to/repo
```

Trimmed sample of the prompt the CLI emits (synthesized; not live output). The new ordering leads with a ranked shortlist, then a single-line lead, then the supporting graph context, then the protocol:

```
# Failure context

Investigating symbol: login

---

## Top causal candidates

Ranked by recency × topology × ambiguity × co-change. Higher score = more likely root-cause site.

1. **`verifyPassword`** (`src/auth/password.ts:12`) — score 8.4, role=callee, distance=1
   Touched 4 days ago in the same commit that landed the failing test; one unresolved sibling call.
   Recent: 7c1a4ef "tighten password compare timing" (4d ago)
   Unresolved calls: timingSafeEqual

2. **`login`** (`src/auth/login.ts:42`) — score 6.1, role=anchor, distance=0
   Anchor symbol; co-changed with verifyPassword in the last 90 days.
   Recent: a90b2d3 "add token rotation hook" (51d ago)

3. **`issueToken`** (`src/auth/token.ts:24`) — score 4.7, role=callee, distance=1
   Adjacent in the call tree but no recent edits.

---

## First hypothesis

The root cause is most likely in verifyPassword (src/auth/password.ts:12) — Touched 4 days ago in the same commit that landed the failing test; one unresolved sibling call.

---

## Graph context

**Primary symbol:** `login`
**Scope:** 14 files, 87 symbols, 152 edges

### Definition

- function login  src/auth/login.ts:42-71  exported

### Callers (depth 2)

- handleLoginRoute  src/api/routes.ts:18  confidence=1.0
  - registerRoutes  src/api/index.ts:9  confidence=1.0
- loginFromCli      src/cli/auth.ts:33   confidence=1.0

### Callees (depth 1)

- verifyPassword  src/auth/password.ts:12  confidence=1.0
- issueToken      src/auth/token.ts:24     confidence=1.0
- audit.record    (unresolved)             confidence=0.5

### Recently changed (last 90 days)

- 7c1a4ef  Sebastien Denes  2026-04-22  tighten password compare timing
- a90b2d3  Maya Patel       2026-03-11  add token rotation hook

---

# Root-cause-analysis protocol

(...standard 7-step protocol...)
```

## The five queries

- `definitionOf(name)` — every symbol declaration matching `name`, with file, line range, signature, exported flag.
- `callersOf(name, depth)` — reverse call tree up to depth, deduped by `(file, name)`.
- `calleesOf(name, depth)` — forward call tree; unresolved targets surface as `resolved=false` with confidence ~0.5.
- `symbolsInFile(path)` — every symbol declared in a file, in source order.
- `recentlyChangedNear(name, sinceDays)` — `git log -L` over the symbol's line range; returns commits that touched those lines.

## Limitations (v1)

Stubbed on purpose. The graph favors honest fallbacks over silent guesses:

- **TS path aliases** (`tsconfig.json` `paths`, `baseUrl`) are not resolved. Bare specifiers fall back to workspace-package lookup or stay unresolved.
- **Re-exports** (`export * from "./x"`, `export { y } from "./z"`) are not followed.
- **Barrel files** are treated as ordinary modules.
- **`self`/`this` dispatch** is a conservative heuristic: single match in the parent class wins at confidence 1.0; one match elsewhere by name gets 0.7; otherwise unresolved.
- **Namespace member calls** (`mod.fn()` after `import * as mod`) are captured but not resolved across files.
- **Languages**: TS family (`.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs`) and Python (`.py/.pyi`). Everything else is recorded as `unparsed`.

## Status

v1. Both the library API (`indexScope`, `runRca`, the five queries) and the `cgrca` CLI shape shown above are the actual interface. See `docs/` for architecture, the RCA protocol, and the language-extension guide.
