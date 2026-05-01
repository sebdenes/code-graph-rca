# code-graph-rca-ui

Web UI for [code-graph-rca](https://www.npmjs.com/package/code-graph-rca). Constellation-style force-directed graph view, Monaco code inspector, RCA + Impact tabs.

## Install

```sh
npm install -g code-graph-rca-ui          # also pulls code-graph-rca
```

## Use

```sh
# 1. Generate a session sqlite from a real bug:
cgrca rca symbol:login --repo /path/to/repo --persist /tmp/session.sqlite

# 2. Open the visual UI:
cgrca-view /tmp/session.sqlite           # opens browser at 127.0.0.1:7331
```

## Three views

- **Graph (default)** — Constellation aesthetic: glowing nodes by kind, faint edge weave, **causal halos** sized by score, **recency rings** colored by 7d/30d/90d. Click any node to slide in a Monaco panel with the source.
- **RCA** — ranked causal candidates with score breakdown, signal weights (recency × proximity × ambiguity × co-change × subsystem), recent commits per node, and a focused call-graph view.
- **Impact** — forward propagation from any symbol: tree, hop-grouped graph, ranked-by-risk table, "high blast radius" banner.

## Flags

```sh
cgrca-view <path-or-dir> [--port N] [--no-open] [--watch] [--dev]
```

- `<path-or-dir>` — a `.sqlite` session file or a directory containing many.
- `--port` defaults to 7331; falls back through 7340 if busy.
- `--watch <repo>` re-indexes on file change (chokidar). Streams events over WebSocket to the UI.

## License

MIT.
