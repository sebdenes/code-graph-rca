# code-graph-rca-ui

Visual viewer for [code-graph-rca](https://www.npmjs.com/package/code-graph-rca)'s knowledge graph and RCA results. Open any persisted `cgrca` session and you get a Constellation-style force-directed view of the indexed neighborhood, a ranked-candidate RCA panel with score breakdowns, and an Impact (blast-radius) tree — plus a Monaco code inspector that slides in on any node click. Built for the moment after `cgrca rca` returns: when the agent (or you) wants to see the structural picture, not just read it.

For the high-level pitch and architecture, see the [repo README](https://github.com/sebdenes/code-graph-rca#readme).

## Install

```sh
npm install -g code-graph-rca-ui
```

This pulls `code-graph-rca` as a dep, so installing the UI gets you the engine too. Currently v0.4.0.

## Run

```sh
# 1. Generate a session sqlite from a real failure:
cgrca rca symbol:login --repo /path/to/repo --persist /tmp/session.sqlite

# 2. Open the visual UI:
cgrca-view /tmp/session.sqlite          # opens browser at 127.0.0.1:7331
cgrca-view --port 7331                  # browse ~/.cgrca/sessions
cgrca-view ./sessions-dir               # browse a directory of sessions
```

`<sqlite-path-or-dir>` accepts either a single `.sqlite` session file or a directory of them. With no path argument, the server lists `~/.cgrca/sessions` plus the current working directory.

| Flag | Default | Notes |
| --- | --- | --- |
| `--port N` | `7331` | Auto-increments through `7340` if busy. |
| `--no-open` | off | Don't launch the system browser. |
| `--watch <repo>` | off | Re-index on file change (chokidar). Streams `LiveEvents` over WebSocket to the UI. |
| `--dev` | off | API-only mode (no SPA static serving — for local UI dev). |

## Three tabs

- **Constellation graph** (default) — Cytoscape-rendered force-directed view. Nodes glow by kind, edges weave faintly, **causal halos** size by score, **recency rings** color by 7d / 30d / 90d. File-scope nebulas (capped at **24 clusters** — past that, the SVG layer hangs the renderer on large repos like a 28k-symbol Python checkout) give a cartographic sense of which subsystem you're in. Smart-labels avoid collision via a per-frame layout pass over the top-N highest-degree files. Click any node to slide in a Monaco source panel.
- **RCA candidates** — the ranked output: score breakdown per signal (recency × proximity × ambiguity × co-change × subsystem × complexity × dataflow), recent commits per node, and a focused call-graph view around each candidate.
- **Impact tree** — forward propagation from any symbol: tree view, hop-grouped graph, ranked-by-risk table, and a "high blast radius" banner when a single change reaches a lot of dependents.

A file-scope filter (shipped early in this release cycle) lets you collapse the graph to a single file's symbols + their direct neighbors, which is the right view for "what does this PR's diff actually touch?"

## Bridge mode

The UI advertises itself to local MCP servers by writing `~/.cgrca/bridge.json` (`{ url, port, pid, sessionsDir }`) on listen and removing it on shutdown. When `cgrca`'s MCP server sees that file, the agent can call `cgrca_currentSelection` to read whatever symbol you're focused on in the UI, or `cgrca_publishSelection` to push the agent's focus back to the graph. The two views stay in sync — useful when an agent is investigating and you want to follow along visually (or vice versa).

## Status

Tracks `code-graph-rca` major/minor releases; designed to open any sqlite produced by `cgrca rca --persist` (schema v6).

## License

MIT.
