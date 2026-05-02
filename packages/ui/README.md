# code-graph-rca-ui

*part of [Halo](https://github.com/sebdenes/code-graph-rca)*

**Halo's visual viewer.** Three views over the same indexed knowledge graph: a Constellation force-directed map of the neighborhood, an Evidence Board that lays out Halo's 7-signal causal dossier next to the lit code excerpt, and an Impact Forward Constellation that projects blast-radius outward from any symbol. Built for the moment after Halo's CLI hands you a session — when the agent (or you) wants to see the structural picture, not just read it.

For Halo's product overview and architecture, see the [repo README](https://github.com/sebdenes/code-graph-rca#readme).

## Install

```sh
npm install -g code-graph-rca-ui
```

This pulls `code-graph-rca` (Halo's engine) as a dep, so installing the viewer gets you the full Halo CLI too. Currently v0.4.4.

## Run

```sh
# 1. Generate a session sqlite from a real failure (Halo's CLI):
cgrca rca symbol:login --repo /path/to/repo --persist /tmp/session.sqlite

# 2. Open Halo's viewer:
cgrca-view /tmp/session.sqlite          # opens browser at 127.0.0.1:7331
cgrca-view --port 7331                  # browse ~/.cgrca/sessions
cgrca-view ./sessions-dir               # browse a directory of sessions
```

`<sqlite-path-or-dir>` accepts either a single `.sqlite` session file or a directory of them. With no path argument, the server lists `~/.cgrca/sessions` plus the current working directory.

| Flag | Default | Notes |
| --- | --- | --- |
| `--port N` | `7331` | Auto-increments through `7340` if busy. |
| `--no-open` | off | Don't launch the system browser. |
| `--watch <repo>` | off | Re-index on file change (chokidar). Streams `LiveEvents` over WebSocket. |
| `--dev` | off | API-only mode (no SPA static serving — for local UI dev). |

## The three tabs

- **Constellation graph** (default) — Cytoscape-rendered force-directed view. Nodes glow by kind, edges weave faintly, **causal halos** size by score, **recency rings** color by 7d / 30d / 90d. File-scope nebulas (capped at **24 clusters** — past that, the SVG layer hangs the renderer on large repos like a 28k-symbol Python checkout) give a cartographic sense of which subsystem you're in. Smart-labels avoid collision via a per-frame layout pass over the top-N highest-degree files. Click any node to slide in a Monaco source panel.
- **RCA Evidence Board** — Halo's ranked candidates rendered as radial dossiers: each candidate is a 7-spoke wheel (recency × proximity × ambiguity × co-change × subsystem × complexity × dataflow) with the contributing values lit, the recent commits stacked beside it, and the lit code excerpt rendered on the right. The focused candidate's call-graph neighborhood floats beneath. This is the view you reach for when you need to defend the rank.
- **Impact Forward Constellation** — forward propagation from any symbol: tree view, hop-grouped graph, ranked-by-risk table, file-blast-radius rollup, and a "high blast radius" banner colored on the risk colormap when a single change reaches a lot of dependents.

A file-scope filter lets you collapse the graph to a single file's symbols + their direct neighbors — the right view for "what does this PR's diff actually touch?"

## Bridge mode

Halo's viewer advertises itself to local MCP servers by writing `~/.cgrca/bridge.json` (`{ url, port, pid, sessionsDir }`) on listen and removing it on shutdown. When Halo's MCP server sees that file, the agent can call `cgrca_currentSelection` to read whatever symbol you're focused on in the viewer, or `cgrca_publishSelection` to push the agent's focus back to the graph. The two views stay in sync — useful when an agent is investigating and you want to follow along visually (or vice versa).

## Status

Tracks Halo engine releases; designed to open any sqlite produced by `cgrca rca --persist` (schema v6).

## License

MIT.
