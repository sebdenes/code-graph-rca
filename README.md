<div align="center">

# Halo

**RCA infrastructure for AI-built code.** Lights up the bug.

[![npm version](https://img.shields.io/npm/v/code-graph-rca.svg?label=core&style=flat-square)](https://www.npmjs.com/package/code-graph-rca)
[![ui version](https://img.shields.io/npm/v/code-graph-rca-ui.svg?label=ui&style=flat-square)](https://www.npmjs.com/package/code-graph-rca-ui)
[![github-app version](https://img.shields.io/npm/v/code-graph-rca-github-app.svg?label=github-app&style=flat-square)](https://www.npmjs.com/package/code-graph-rca-github-app)
[![CI](https://img.shields.io/github/actions/workflow/status/sebdenes/code-graph-rca/cgrca.yml?branch=main&label=cgrca%20PR%20review&style=flat-square)](https://github.com/sebdenes/code-graph-rca/actions/workflows/cgrca.yml)
[![license](https://img.shields.io/npm/l/code-graph-rca.svg?style=flat-square)](LICENSE)

</div>

---

## What it does

Given a failure — a stack trace, a failing test, a symbol, a file — Halo walks outward from the failure scope, indexes just those files with [tree-sitter](https://tree-sitter.github.io/) into SQLite, then returns a **ranked table of causal candidates** scored by recency, proximity, ambiguity, co-change, and subsystem. The agent (or you) reads the top of the table and starts there instead of grepping.

![Ranked causal candidates table — the default `cgrca rca` output](docs/screenshots/02-rca.png)

## Install

```sh
npm i -g code-graph-rca
# optional companions
npm i -g code-graph-rca-ui            # the Constellation graph viewer (cgrca-view)
npm i -g code-graph-rca-github-app    # PR review + Sentry incident webhooks
```

For MCP-aware editors (Cursor, Claude Code, Cody, Cline, Continue, Windsurf, Zed):

```sh
cd /path/to/repo
cgrca init           # interactive — detects editors, prints a plan, asks before mutating
cgrca init --yes     # non-interactive (CI / scripts)
```

`init` registers cgrca's MCP server with every editor it finds and drops `AGENTS.md` at the repo root teaching the agent when to call which tool.

## 5-minute walkthrough

```sh
# 1. Wire cgrca into your editor + drop AGENTS.md
cgrca init --yes

# 2. Run RCA on a symbol — get a ranked candidate table back
cgrca rca symbol:foo --repo /path/to/repo

# 3. Start the daemon — subsequent queries are warm (~500x faster)
cgrca daemon start
cgrca callers foo --repo /path/to/repo     # ~30ms instead of ~17s
```

## What's in v0.4

- **Calibrated ranker.** Causal-scorer weights are no longer hand-set — they're fit by logistic regression against a labeled corpus of real bugs. The full per-week tooling lives in [`tools/calibration/`](tools/calibration/).
- **`cgrcad` daemon.** Long-lived process holding one persisted SQLite per repo. Blob-sha cache skips re-parsing unchanged files; an fs-watcher invalidates on edit. JSON-RPC over a unix socket. `cgrca daemon start | stop | status`.
- **MCP routes through the daemon.** When `cgrcad` is up, the MCP server forwards every query to it instead of re-indexing in-process. Falls through silently when the daemon isn't running.
- **Sentry / generic incident webhooks.** The github-app handler ingests Sentry events (or a generic `{ message, stack, file }` shape) and opens a GitHub issue with ranked causal candidates and a first hypothesis.
- **Python receiver-type inference.** Resolution rate on large Python codebases jumped from 1.2% to 91.3% — `self.foo()` and `obj.method()` calls now resolve to the right class via local type inference.
- **8.6× faster index.** 17.2s → 2.0s warm on a real ~17k-file repo, via tree-sitter query cache + blob-sha cache + an FK-cascade fix.
- **Local-variable extraction.** Loop vars, nested-block bindings, destructuring patterns — TS and Python.
- **Engine ↔ prompt-format split.** `runRca({ format: 'structured' })` returns just the ranked candidates for tool consumers; `format: 'prompt'` keeps the markdown-blob behavior.
- **Hardening.** Symlink-loop safety, MCP concurrent-request race fix, anonymous-author commit support, schema versioning + migrations (current: v6).
- **329 tests** across the 3 packages.

## Three surfaces

**CLI** — direct invocation, scripting, CI. The default output is a colored ranked table; pass `--format prompt` for the full LLM-grounding markdown, `--format json` for tool consumption.

```sh
cgrca rca symbol:login --repo /path/to/repo
```

**MCP server** — stdio transport, eight tools any MCP-aware agent picks up. `cgrca init` registers it with every editor it finds.

```sh
cgrca mcp /path/to/repo    # usually you don't run this — your editor does
```

**GitHub App / Action** — PR review bot that posts ranked causal candidates as a comment, plus an incident webhook that turns Sentry events (or any `{ message, stack, file }` payload) into ranked GitHub issues.

```sh
cgrca-pr-review --pr 123    # see packages/github-app/README.md
```

## Architecture

Halo is **scope-then-index**: a bounded BFS over imports + reverse callers picks 5–10k LOC around the failure, then a two-pass tree-sitter parser builds an in-memory SQLite (or persisted with `--persist <path>`). Seven query primitives sit on top — `definitionOf`, `callersOf`, `calleesOf`, `symbolsInFile`, `recentlyChangedNear`, `scope`, `rca`. The daemon model keeps one persisted DB per repo warm in a long-lived process and invalidates per-file via fs-watch + blob-sha. The causal scorer is a calibrated linear combination of recency, proximity, ambiguity, co-change, and subsystem signals.

## Status

Alpha. Semantic-versioned. MIT.

---

> **Naming.** The product is *Halo*. The npm packages and binaries are `code-graph-rca` / `code-graph-rca-ui` / `code-graph-rca-github-app` and `cgrca` / `cgrca-view` / `cgrca-pr-review` / `cgrcad`. Those names are stable.

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — scope-then-index bet, schema, two-pass design, honest fallbacks
- **[docs/RCA_PROTOCOL.md](docs/RCA_PROTOCOL.md)** — the seven-step protocol embedded in every cgrca prompt
- **[docs/EXTENDING.md](docs/EXTENDING.md)** — adding a language
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — project layout, tests, coding standards
- **[packages/core/README.md](packages/core/README.md)** — engine details, all CLI flags
- **[packages/ui/README.md](packages/ui/README.md)** — Constellation viewer
- **[packages/github-app/README.md](packages/github-app/README.md)** — PR review + Sentry incidents
