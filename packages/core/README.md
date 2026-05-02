# code-graph-rca

*part of [Halo](https://github.com/sebdenes/code-graph-rca)*

**Halo's engine + CLI + MCP server.** Halo grounds AI coding agents in the real structure of your codebase: a tree-sitter knowledge graph, a calibrated 7-signal causal ranker for root-cause analysis, and a long-lived daemon that keeps queries warm. This package is the heart of Halo — the indexer, the ranker, the `cgrca` CLI, and the MCP server that nine MCP-aware editors (Cursor, Claude Code, Cody, Cline, Continue, Windsurf, Zed, …) speak natively.

For Halo's product overview and architecture, see the [repo README](https://github.com/sebdenes/code-graph-rca#readme). This page is the canonical reference for the `cgrca` binary, Halo's MCP server, and the `cgrcad` daemon.

## Install

```sh
npm install -g code-graph-rca
```

v0.4.1 — calibrated causal weights, persistent `cgrcad` daemon, 9 MCP tools, SQLite schema v6.

## CLI

The `cgrca` binary is Halo's CLI. One command per question.

| Subcommand | What it does |
| --- | --- |
| `cgrca init [path]` | Detect editor MCP configs, register Halo, drop `AGENTS.md`. Prints a plan; `--yes` to apply, `--dry-run` to preview. |
| `cgrca rca <failure>` | Run RCA on a failure. Default output: ranked candidate table. |
| `cgrca define <name>` | Find symbol declarations (`definitionOf`). |
| `cgrca callers <name>` | Reverse call tree. `-d/--depth N` (default 2). |
| `cgrca callees <name>` | Forward call tree. `-d/--depth N` (default 1). |
| `cgrca changed <name>` | `git log -L` for the symbol's lines. `--since <days>` (default 90). |
| `cgrca index <path>` | Index a scope and print summary stats (files, symbols, edges, imports). |
| `cgrca mcp [path]` | Start Halo's MCP server on stdio. Wired automatically by `cgrca init`. |
| `cgrca daemon <start\|stop\|status>` | Manage the long-lived `cgrcad` cache. |

`<failure>` accepts `symbol:<name>`, `file:<path>`, `test:<path>`, or a path to a file containing a stack trace.

```sh
cgrca rca symbol:login --repo /path/to/repo
cgrca rca /tmp/stacktrace.txt --repo /path/to/repo --persist /tmp/x.sqlite
cgrca callers login --repo /path/to/repo -d 3
cgrca changed login --repo /path/to/repo --since 30
```

## How Halo grounds the LLM (MCP integration)

```sh
cgrca init --yes
```

That writes the right config block into every editor MCP config Halo finds (Cursor, Claude Code, Cline, Continue, Windsurf, Zed, etc.) and drops an `AGENTS.md` at the repo root. Restart your editor — the agent now sees nine Halo tools:

- `cgrca_rcaPrompt` — full grounded RCA prompt (failure context + ranked candidates + first hypothesis + graph context + 7-step protocol). Drop straight into the reasoning loop.
- `cgrca_rca` — same RCA, returned as structured JSON.
- `cgrca_definitionOf` — symbol declarations.
- `cgrca_callersOf` — reverse call tree, depth 1–5.
- `cgrca_calleesOf` — forward call tree.
- `cgrca_symbolsInFile` — every symbol in a file.
- `cgrca_recentlyChangedNear` — `git log -L` for a symbol.
- `cgrca_scope` — dry-run preview of which files Halo would index for a given failure.
- `cgrca_currentSelection` / `cgrca_publishSelection` — bridge mode (read/write the symbol focused in Halo's viewer, opt-in via `~/.cgrca/bridge.json`).

When `cgrcad` is up, MCP tool calls become daemon RPCs instead of fresh in-process indexes — agent latency drops from seconds to tens of milliseconds.

## Daemon

```sh
cgrca daemon start
cgrca daemon status
cgrca daemon stop
```

`cgrcad` is the long-lived process behind warm Halo. One persistent SQLite per repo, keyed by realpath. JSON-RPC 2.0 over a Unix domain socket. A blob-SHA cache (`git hash-object --batch`) joined against cached extraction JSON means N tree-sitter parses collapse to 1 on a warm repo with one dirty file. An `fs.watch` recursive watcher invalidates per-file (graceful degrade to stat-on-query if `EMFILE`/`ENOSPC`).

When `cgrcad` is running, `define / callers / callees / changed` reuse its open SQLite handles instead of re-indexing the scope. On a 28k-symbol Python repo this turns a ~17s cold call into ~30ms — a >500× speedup on warm queries. Pass `--no-daemon` to force in-process indexing. Per-repo caches live under `~/.cgrca/repos/`.

## The `rca` output

Three shapes, picked via `--format=table|prompt|json` (legacy aliases `--prompt` and `--json` still work):

- **`table`** (default) — ranked candidate table with score, role, symbol, location, and a one-line "why". Top candidate red, fading to dim.
- **`prompt`** — the full LLM-grounding markdown: failure context, top causal candidates, first hypothesis, graph context, 7-step RCA protocol. Paste into any model.
- **`json`** — full `RcaResult` for machine consumers (Halo's viewer, scripts, evals).

Other useful flags: `--top-n N` (default 5), `--max-files`, `--max-loc`, `--persist <path>` (write the indexed graph to a SQLite file — Halo's viewer opens these directly).

## The 7 causal signals

Halo's ranker scores each candidate as a weighted sum of seven signals, then sorts:

- **Recency** — how recently the symbol's lines were touched (`git log -L`, decays past `recencyDays`).
- **Proximity** — graph distance from the failure anchor along call edges.
- **Ambiguity** — count of unresolved outgoing edges (dynamic dispatch, missing receiver type).
- **Co-change** — how often this symbol changes in the same commit as the anchor.
- **Subsystem** — same package/module path as the anchor scores higher.
- **Complexity** — symbol size and edge fan-out as a tractable proxy.
- **Dataflow** — `pathBetween` over CALLS + arg-binding edges (currently weight-0 in the calibrated default; see calibration).

## Calibration

Weights are logistic-regression fit against a labelled corpus of 101 PR-fix incidents (the actual fix site is the positive label, all other top-ranked candidates are negatives). Three signals carry most of the discriminative power in the current fit (subsystem, co-change, ambiguity); proximity and dataflow clipped to zero — already absorbed by other signals on the eval set. Pass `--legacy-weights` to A/B against the pre-calibration hand-set weights. The fit code and rationale live in `packages/core/src/rca/causal.ts`.

## Schema and persistence

SQLite **schema v6**. Stored either in-memory (default) or on disk via `--persist <path>`. The daemon manages a per-repo cache at `~/.cgrca/repos/`. Persisted databases are stamped with `repo_root`, `primary_symbol`, and `schema_version` in a `meta` table, and ship with a sidecar `<path>.rca.json` snapshot of the full `RcaResult` so Halo's viewer can render them standalone. v6 added `symbols.type_text` to capture raw type-annotation text on `param` and `local` rows — the substrate for receiver-type inference.

## Languages

TypeScript family (`.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs`) and Python (`.py/.pyi`). Other extensions are recorded as `unparsed` so the file tree stays complete. Shipped in v0.4: receiver-type inference for both Python and TS, and Python `as`-pattern extraction in `with` / `except` blocks — together they shrink the unresolved-edge tail substantially on real codebases (Python resolution rate 1.2% → 91% on the calibration corpus).

## Visual exploration

Halo's viewer ships in a separate package — [`code-graph-rca-ui`](https://www.npmjs.com/package/code-graph-rca-ui). Open any persisted Halo session:

```sh
cgrca rca symbol:bug --repo . --persist /tmp/x.sqlite
cgrca-view /tmp/x.sqlite
```

## Status

Production-usable for daily RCA + agent grounding on TS and Python repos up to ~30k symbols.

## License

MIT.
