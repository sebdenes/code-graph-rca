<div align="center">

# Halo

</div>

*RCA infrastructure for AI-built code. Given a failure — a stack trace, a failing test, a symbol, a file — Halo walks outward from the failure scope, indexes just those files into a knowledge graph, and returns a ranked table of causal candidates. The agent (or you) reads the top of the table and starts there instead of grepping.*

![Ranked causal candidates — Halo's default RCA output](docs/screenshots/02-rca.png)

## Install

```sh
npm i -g code-graph-rca            # CLI + MCP server
npm i -g code-graph-rca-ui         # Constellation / RCA / Impact viewer (optional)
npm i -g code-graph-rca-github-app # PR review + Sentry incident bot (optional)
```

The first package is the engine — it ships the `cgrca` binary, the MCP server, and the daemon. The second is the visual surface (`cgrca-view`). The third runs on a server and brings Halo to GitHub PRs and incident webhooks.

## 5-minute walkthrough

```sh
cgrca init --yes                   # detect editors, register the MCP server, drop AGENTS.md
cgrca rca symbol:foo               # rank causal candidates for a failing symbol
cgrca daemon start                 # warm queries, ~500x faster on the second hit
```

`init` is idempotent and prints a plan before mutating user config. `rca` accepts `symbol:<name>`, `file:<path>`, `test:<path>`, or a path to a file containing a stack trace. The daemon holds one persisted SQLite per repo and invalidates per-file via fs-watch + blob-sha; the MCP server transparently routes through it when it's up.

## What Halo does

- Walks your repo with [tree-sitter](https://tree-sitter.github.io/) — TypeScript and Python today, more on the way.
- Builds a knowledge graph in SQLite — files, symbols, calls, imports, definitions, edges with confidence.
- Bounds the work to the failure scope — a BFS over imports + reverse callers picks 5–10k LOC instead of the whole repo.
- Ranks causal candidates with seven calibrated signals — recency, proximity, ambiguity, co-change, subsystem, churn, role — fit by logistic regression against a labeled corpus of real bugs.
- MCP-native — every MCP-aware editor (Cursor, Claude Code, Cody, Cline, Continue, Windsurf, Zed) sees the same nine tools.
- Long-lived daemon — blob-sha cache, fs-watch invalidation, JSON-RPC over a unix socket; warm queries land in ~30ms.
- GitHub Action + Sentry/incident webhook — the same engine ranks candidates inside PR comments and turns Sentry events into ranked GitHub issues.
- Open core, MIT.

## Three surfaces

**CLI.** Direct invocation, scripting, CI. The default output is a colored ranked table; `--format prompt` emits the full LLM-grounding markdown, `--format json` emits structured data for tool consumers.

```sh
cgrca rca symbol:login --repo /path/to/repo
```

**MCP server.** Stdio transport, nine tools any MCP-aware agent picks up. You usually don't run this directly — `cgrca init` registers it with every editor it finds and drops an `AGENTS.md` at the repo root teaching the agent when to call which tool.

```sh
cgrca mcp /path/to/repo
```

**GitHub App / Action.** A PR review bot that posts ranked causal candidates as a comment, plus an incident webhook that ingests Sentry events (or any `{ message, stack, file }` payload) and opens a GitHub issue with ranked candidates and a first hypothesis.

```sh
cgrca-pr-review --pr 123
```

## What's in v0.4

- **Calibrated ranker.** Causal-scorer weights are fit by logistic regression against a labeled corpus of real bugs; tooling lives in [`tools/calibration/`](tools/calibration/).
- **8.6× faster index.** 17.2s → 2.0s warm on a real ~17k-file repo, via tree-sitter query cache + blob-sha cache + an FK-cascade fix.
- **91.3% Python identifier resolution.** Receiver-type inference resolves `self.foo()` and `obj.method()` to the right class — up from 1.2%.
- **`cgrcad` daemon.** Long-lived process holding one persisted SQLite per repo. Blob-sha cache skips re-parsing unchanged files; an fs-watcher invalidates on edit. JSON-RPC over a unix socket.
- **MCP routes through the daemon.** When `cgrcad` is up, the MCP server forwards every query to it instead of re-indexing in-process. Falls through silently when the daemon isn't running.
- **Sentry / generic incident webhooks.** The github-app handler turns incoming events into a GitHub issue with ranked causal candidates and a first hypothesis.
- **Observatory UI tabs.** The viewer is now a three-tab Observatory — Constellation (graph), RCA (ranked table), Impact (blast radius) — sharing one selection state via the `currentSelection` / `publishSelection` MCP bridge.
- **Hardening.** Symlink-loop safety, MCP concurrent-request race fix, schema versioning + migrations (current: v6), 329 tests across the 3 packages.

## Architecture

Halo is **scope-then-index**: a bounded BFS over imports + reverse callers picks 5–10k LOC around the failure, then a two-pass tree-sitter parser builds an in-memory SQLite (or persisted with `--persist <path>`). Seven query primitives sit on top — `definitionOf`, `callersOf`, `calleesOf`, `symbolsInFile`, `recentlyChangedNear`, `scope`, `rca`. The daemon model keeps one persisted DB per repo warm in a long-lived process; the calibrated causal scorer is a linear combination of recency, proximity, ambiguity, co-change, and subsystem signals. Deep dive: [`tools/cgrcad/DESIGN.md`](tools/cgrcad/DESIGN.md).

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — scope-then-index bet, schema, two-pass design, honest fallbacks
- [`docs/RCA_PROTOCOL.md`](docs/RCA_PROTOCOL.md) — the seven-step protocol embedded in every Halo prompt
- [`docs/EXTENDING.md`](docs/EXTENDING.md) — adding a language
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — project layout, tests, coding standards
- [`packages/core/README.md`](packages/core/README.md) — engine details, all CLI flags
- [`packages/ui/README.md`](packages/ui/README.md) — Observatory viewer
- [`packages/github-app/README.md`](packages/github-app/README.md) — PR review + Sentry incidents

## Status

Alpha. Semantic-versioned. MIT. See [CHANGELOG.md](CHANGELOG.md).

---

<sub>*Halo* is the brand; `code-graph-rca` is the npm namespace; `cgrca` is the binary.</sub>
