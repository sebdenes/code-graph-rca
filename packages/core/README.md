# code-graph-rca

**RCA infrastructure for AI-built code.** A code knowledge graph and an opinionated root-cause-analysis engine, exposed through three surfaces: an MCP server (every MCP-aware agent — Cursor, Claude Code, Cody, Cline, Continue, Windsurf, Zed — speaks it natively), a CLI for direct use and CI, and a library (`import { runRca, definitionOf, callersOf, ... } from "code-graph-rca"`). cgrca answers the structural questions ("who calls this", "what changed near this symbol", "what's the most likely root cause given this stack trace") with confidence-graded edges, recent-change blame, and a calibrated causal ranking — so your agent stops guessing about the codebase and starts citing it.

For the high-level pitch and architecture, see the [repo README](https://github.com/sebdenes/code-graph-rca#readme). This page is the canonical reference for the `cgrca` binary, the MCP server, and the daemon.

## Install

```sh
npm install -g code-graph-rca
```

v0.4.0 — calibrated weights, persistent daemon, 9 MCP tools, SQLite schema v6.

## CLI

| Subcommand | What it does |
| --- | --- |
| `cgrca init [path]` | Detect editor MCP configs, register cgrca, drop `AGENTS.md`. Prints a plan; `--yes` to apply, `--dry-run` to preview. |
| `cgrca rca <failure>` | Run RCA on a failure. Default output: ranked candidate table. See "rca output" below. |
| `cgrca define <name>` | Find symbol declarations (`definitionOf`). |
| `cgrca callers <name>` | Reverse call tree. `-d/--depth N` (default 2). |
| `cgrca callees <name>` | Forward call tree. `-d/--depth N` (default 1). |
| `cgrca changed <name>` | `git log -L` for the symbol's lines. `--since <days>` (default 90). |
| `cgrca index <path>` | Index a scope and print summary stats (files, symbols, edges, imports). |
| `cgrca mcp [path]` | Start the MCP server on stdio. Wired automatically by `cgrca init`. |
| `cgrca daemon <start\|stop\|status>` | Manage the long-lived `cgrcad` cache. |

`<failure>` accepts `symbol:<name>`, `file:<path>`, `test:<path>`, or a path to a file containing a stack trace.

```sh
cgrca rca symbol:login --repo /path/to/repo
cgrca rca /tmp/stacktrace.txt --repo /path/to/repo --persist /tmp/x.sqlite
cgrca callers login --repo /path/to/repo -d 3
cgrca changed login --repo /path/to/repo --since 30
```

## MCP integration

```sh
cgrca init --yes
```

That writes the right config block into every editor MCP config it finds (Cursor, Claude Code, Cline, Continue, Windsurf, Zed, etc.) and drops an `AGENTS.md` at the repo root. Restart your editor — the agent now sees nine tools:

- `cgrca_rcaPrompt` — full grounded RCA prompt (failure context + ranked candidates + first hypothesis + graph context + 7-step protocol). Drop straight into the reasoning loop.
- `cgrca_rca` — same RCA, returned as structured JSON.
- `cgrca_definitionOf` — symbol declarations.
- `cgrca_callersOf` — reverse call tree, depth 1–5.
- `cgrca_calleesOf` — forward call tree.
- `cgrca_symbolsInFile` — every symbol in a file.
- `cgrca_recentlyChangedNear` — `git log -L` for a symbol.
- `cgrca_scope` — dry-run preview of which files cgrca would index for a given failure.
- `cgrca_currentSelection` / `cgrca_publishSelection` — bridge mode (read/write the symbol focused in `cgrca-view`, opt-in via `~/.cgrca/bridge.json`).

## Daemon

```sh
cgrca daemon start
cgrca daemon status
cgrca daemon stop
```

When `cgrcad` is running, `define / callers / callees / changed` reuse its open SQLite handles instead of re-indexing the scope. On a 28k-symbol Python repo this turns a ~17s cold call into ~30ms — a >500× speedup on warm queries. Pass `--no-daemon` to force in-process indexing. Per-repo caches live under `~/.cgrca/repos/`.

## The `rca` output

Three shapes, picked via `--format=table|prompt|json` (or the legacy aliases `--prompt` and `--json`):

- **`table`** (default) — ranked candidate table with score, role, symbol, location, and a one-line "why". Top candidate red, fading to dim; this is the actual signal cgrca produces.
- **`prompt`** — the full LLM-grounding markdown: failure context, top causal candidates, first hypothesis, graph context, 7-step RCA protocol. Paste straight into any model.
- **`json`** — full `RcaResult` for machine consumers (the UI, scripts, evals).

Other useful flags: `--top-n N` (default 5), `--max-files`, `--max-loc`, `--persist <path>` (write the indexed graph to a SQLite file — the UI opens these directly).

## The 7 causal signals

Each candidate is scored as a weighted sum of seven signals, then sorted:

- **Recency** — how recently the symbol's lines were touched (`git log -L`, decays past `recencyDays` window).
- **Proximity** — graph distance from the failure anchor along call edges.
- **Ambiguity** — count of unresolved outgoing edges from the symbol (dynamic dispatch, missing receiver type).
- **Co-change** — how often this symbol changes in the same commit as the anchor.
- **Subsystem** — same package/module path as the anchor scores higher.
- **Complexity** — symbol size and edge fan-out as a tractable proxy.
- **Dataflow** — `pathBetween` over CALLS + arg-binding edges (currently weight-0 in the calibrated default; see calibration notes).

## Calibration

Weights are logistic-regression fit against a labelled corpus of 101 PR-fix incidents (the actual fix site is the positive label, all other top-ranked candidates are negatives). Three signals carry most of the discriminative power in the current fit (subsystem, co-change, ambiguity); proximity and dataflow clipped to zero — they were already absorbed by other signals on the eval set. Pass `--legacy-weights` to A/B against the pre-calibration hand-set weights. The fit code and rationale live in `packages/core/src/rca/causal.ts`.

## Schema and persistence

SQLite **v6**. Stored either in-memory (default) or on disk via `--persist <path>` — and the daemon manages a per-repo cache at `~/.cgrca/repos/`. Persisted databases are stamped with `repo_root`, `primary_symbol`, and `schema_version` in a `meta` table, and ship with a sidecar `<path>.rca.json` snapshot of the full `RcaResult` so the UI can render them standalone. v6 added `symbols.type_text` to capture raw type-annotation text on `param` and `local` rows — the substrate for receiver-type inference.

## Languages

TypeScript family (`.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs`) and Python (`.py/.pyi`). Other extensions are recorded as `unparsed` so the file tree stays complete. Recently shipped: receiver-type inference (Python and TS) and Python `as`-pattern extraction in `with` / `except` blocks — both shrink the unresolved-edge tail substantially on real codebases.

## Visual exploration

The companion package [`code-graph-rca-ui`](https://www.npmjs.com/package/code-graph-rca-ui) ships `cgrca-view` — a Constellation-style force-directed graph view + Monaco code inspector + RCA & Impact tabs. Open any persisted session:

```sh
cgrca rca symbol:bug --repo . --persist /tmp/x.sqlite
cgrca-view /tmp/x.sqlite
```

## Status

Production-usable for daily RCA + agent grounding on TS and Python repos up to ~30k symbols.

## License

MIT.
