# code-graph-rca

*part of [Halo](https://github.com/sebdenes/code-graph-rca)*

**Halo's engine + CLI + MCP server.** Halo grounds AI coding agents in the real structure of your codebase: a tree-sitter knowledge graph, a calibrated 7-signal causal ranker for root-cause analysis, and a long-lived daemon that keeps queries warm. This package is the heart of Halo — the indexer, the ranker, the `cgrca` CLI, and the MCP server that MCP-aware editors (Cursor, Claude Code, Cody, Cline, Continue, Windsurf, Zed, …) speak natively.

For Halo's product overview and architecture, see the [repo README](https://github.com/sebdenes/code-graph-rca#readme). This page is the canonical reference for the `cgrca` binary, Halo's MCP server, and the `cgrcad` daemon.

## Install

```sh
npm install -g code-graph-rca
```

## CLI

| Subcommand | What it does |
| --- | --- |
| `cgrca init [path]` | Detect editor MCP configs, register Halo, drop `AGENTS.md`. Prints a plan; `--yes` to apply, `--dry-run` to preview. |
| `cgrca rca <failure>` | Run RCA. Uses the daemon's warm index when available, falls back to in-process. Writes a sidecar automatically to `~/.cgrca/repos/`. Notifies the viewer to reload. |
| `cgrca define <name>` | Find symbol declarations (`definitionOf`). |
| `cgrca callers <name>` | Reverse call tree. `-d/--depth N` (default 2). |
| `cgrca callees <name>` | Forward call tree. `-d/--depth N` (default 1). |
| `cgrca changed <name>` | `git log -L` for the symbol's lines. `--since <days>` (default 90). |
| `cgrca index <path>` | Index a scope and print summary stats. |
| `cgrca mcp [path]` | Start Halo's MCP server on stdio. Wired automatically by `cgrca init`. |
| `cgrca daemon <start\|stop\|status>` | Manage the long-lived `cgrcad` cache. |

`<failure>` accepts `symbol:<name>`, `file:<path>`, `test:<path>`, a stack trace file path, or free-text.

```sh
cgrca rca symbol:login --repo /path/to/repo
cgrca rca /tmp/stacktrace.txt
cgrca rca "users randomly get logged out"
cgrca rca symbol:login --llm       # LLM re-rank (needs ANTHROPIC_API_KEY)
cgrca callers login -d 3
cgrca changed login --since 30
```

### RCA sidecar and auto-reload

`cgrca rca` always writes a `.rca.json` sidecar next to the daemon's canonical SQLite at `~/.cgrca/repos/{sha}.sqlite`. No `--persist` flag needed. If `cgrca-view` is running, the CLI reads `~/.cgrca/bridge.json` and POSTs to `/api/bridge/rca-notify` — the viewer's RCA tab reloads without a manual browser refresh.

Use `--persist <path>` only when you want a portable copy at a specific location.

## MCP integration

```sh
cgrca init --yes
```

Writes the right config block into every editor MCP config Halo finds and drops an `AGENTS.md` at the repo root. Restart your editor — the agent now sees these tools:

- `cgrca_rcaPrompt` — full grounded RCA prompt (failure context + ranked candidates + first hypothesis + graph context + 7-step protocol).
- `cgrca_rca` — same RCA as structured JSON.
- `cgrca_definitionOf` — symbol declarations.
- `cgrca_callersOf` — reverse call tree, depth 1–5.
- `cgrca_calleesOf` — forward call tree.
- `cgrca_symbolsInFile` — every symbol in a file.
- `cgrca_recentlyChangedNear` — `git log -L` for a symbol.
- `cgrca_scope` — dry-run preview of which files would be indexed.
- `cgrca_currentSelection` / `cgrca_publishSelection` — bridge mode (sync focus with the viewer).

When `cgrcad` is up, MCP tool calls become daemon RPCs — agent latency drops from seconds to tens of milliseconds.

## Daemon

```sh
cgrca daemon start
cgrca daemon status
cgrca daemon stop
```

`cgrcad` is the long-lived process behind warm Halo. One persisted SQLite per repo, keyed by realpath (`~/.cgrca/repos/{sha16}.sqlite`). JSON-RPC 2.0 over a Unix domain socket.

`cgrca rca` tries the daemon first (warm index + git cache already loaded) and falls back to in-process if the daemon is unavailable or `--no-daemon` is passed. All other commands (`define`, `callers`, `callees`, `changed`) follow the same pattern.

On a 28k-symbol Python repo, daemon reuse turns a ~17s cold call into ~30ms — >500× on warm queries.

## The `rca` output

Three shapes via `--format=table|prompt|json` (legacy aliases `--prompt` / `--json` still work):

- **`table`** (default) — ranked candidate table with score, role, symbol, location, and a one-line "why". Top candidate red, fading to dim.
- **`prompt`** — the full LLM-grounding markdown: failure context, top causal candidates, first hypothesis, graph context, 7-step RCA protocol.
- **`json`** — full `RcaResult` for machine consumers (the viewer, scripts, evals).

## The 7 causal signals

- **Recency** — how recently the symbol's lines were touched (`git log -L`, decays past `recencyDays`).
- **Proximity** — graph distance from the failure anchor along call edges.
- **Ambiguity** — count of unresolved outgoing edges (dynamic dispatch, missing receiver type).
- **Co-change** — how often this symbol changes in the same commit as the anchor.
- **Subsystem** — same package/module path as the anchor scores higher.
- **Complexity** — symbol size and edge fan-out as a tractable proxy.
- **Dataflow** — `pathBetween` over CALLS + arg-binding edges.

## Languages

TypeScript family (`.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs`) and Python (`.py/.pyi`). Other extensions are recorded as `unparsed` so the file tree stays complete.

## Status

Production-usable for daily RCA + agent grounding on TS and Python repos up to ~30k symbols. `v1.0.2`.

## License

MIT.
