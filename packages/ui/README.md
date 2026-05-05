# code-graph-rca-ui

*part of [Halo](https://github.com/sebdenes/code-graph-rca)*

**Halo's visual viewer.** Three tabs over the same indexed knowledge graph: a Constellation force-directed map of the call graph neighborhood, a live RCA Evidence Board where you type any symbol or failure description and get ranked candidates instantly, and an Impact Forward Constellation that projects blast-radius outward from any symbol.

For Halo's product overview and architecture, see the [repo README](https://github.com/sebdenes/code-graph-rca#readme).

## Install

```sh
npm install -g code-graph-rca-ui
```

This pulls `code-graph-rca` (Halo's engine) as a dep, so installing the viewer gets you the full Halo CLI too.

## Run

```sh
cgrca daemon start                  # warm the index for your repo
cgrca-view ~/.cgrca/repos           # opens browser at 127.0.0.1:7331
```

Switch to the **RCA tab** and type a query — no session file needed.

```sh
cgrca-view /path/to/sessions/       # browse a directory of .sqlite files
cgrca-view session.sqlite           # open a single session directly
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--port N` | `7331` | Auto-increments through `7340` if busy. |
| `--no-open` | off | Don't launch the system browser. |
| `--watch <repo>` | off | Re-index on file change. Streams `LiveEvents` over WebSocket. |
| `--dev` | off | API-only mode (no SPA static serving — for local UI dev). |

## The three tabs

**Constellation** (default) — Cytoscape-rendered force-directed view. Nodes glow by kind, edges weave faintly, **causal halos** size by score, **recency rings** color by 7d / 30d / 90d. File-scope nebulas give a cartographic sense of which subsystem you're in. Click any node to slide in a Monaco source panel.

**RCA Evidence Board** — live query bar at the top. Type any of:

```
symbol:MyFunction         ranked candidates anchored on that symbol
file:src/auth.py          rank within a file
test:tests/test_auth.py   from a failing test path
any plain text            treated as a stack trace or description
```

Hit **Investigate** — results appear in a few seconds with no session file, no CLI flag, no restart. Each candidate renders as a 7-signal radial dossier (recency × proximity × ambiguity × co-change × subsystem × complexity × dataflow) with recent commits and a lit code excerpt. The call-graph neighborhood floats in the middle panel.

When `cgrca rca` runs in a terminal, it writes the sidecar and notifies the viewer over the bridge — the RCA tab reloads automatically.

**Impact Forward Constellation** — forward propagation from any symbol: tree view, hop-grouped graph, ranked-by-risk table, file-blast-radius rollup.

## Bridge mode

`cgrca-view` writes `~/.cgrca/bridge.json` on start. Three things use it:

- **MCP peers** — `cgrca_currentSelection` reads the symbol focused in the viewer; `cgrca_publishSelection` pushes the agent's focus back to the graph. The two surfaces stay in sync.
- **CLI auto-reload** — `cgrca rca` reads `bridge.json` after writing a sidecar and POSTs to `/api/bridge/rca-notify`. The viewer receives a `rca-updated` WebSocket event and invalidates the RCA tab — no manual refresh needed.
- **Bridge WebSocket** (`/api/bridge/live`) — any process can subscribe to selection and RCA-updated events.

## Session discovery

`cgrca-view` loads `.sqlite` files from the path you pass (or `~/.cgrca/repos` by default). Each file is a persisted Halo session keyed by repo realpath. The daemon creates and maintains these automatically — you rarely need to manage them directly.

A `.rca.json` sidecar next to a session file pre-loads the last RCA run into the Evidence Board on tab open. The live query bar works regardless of whether a sidecar exists.

## Status

Tracks Halo engine releases. `code-graph-rca@1.0.2` / `code-graph-rca-ui@1.0.4`.

## License

MIT.
