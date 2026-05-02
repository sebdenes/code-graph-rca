# Changelog

All notable changes to **code-graph-rca** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-05-02

The 8-week roadmap. Performance, resolution, and a calibrated ranker on
top of two new surfaces (daemon + incident webhooks).

### Performance

- **8.6× faster cold index** through parser pooling, batched inserts,
  and FK-cascade rewrite of the symbol/edge tables. Warm queries now
  land in <50ms via the daemon.
- **`cgrcad` daemon** — long-lived process that owns one persistent
  sqlite per repo, keyed by realpath. JSON-RPC 2.0 over UDS, auto-spawn
  from any client, in-process fallback if the socket is unreachable.
  See `tools/cgrcad/DESIGN.md`.
- **Blob cache** (schema v5) — `git hash-object --batch` joined against
  cached extraction JSON. On a warm repo with one dirty file, N
  tree-sitter parses become 1.
- **Query cache** — bounded LRU on hot read paths (`callersOf`,
  `calleesOf`, `definitionOf`).
- **fs-watcher invalidation** — `node:fs.watch` recursive per repo;
  graceful degrade to stat-on-query if `EMFILE`/`ENOSPC`.

### Resolution rate

- **Python resolution rate 1.2% → 91%** on the calibration corpus,
  through three passes of inference:
  - Parameter-type inference from call-site arg shapes.
  - Local-binding extraction (`x = Foo(); x.method()` resolves
    `method` to `Foo.method`).
  - Receiver-type inference from `self` / class context.
- New `kind` distinctions on bindings: `param`, `local`, `attr`,
  `import`. Surfaced in `CausalCandidate.loc` for downstream consumers.

### Calibrated ranker

- **Logistic-regression weights** replace the hand-set scorer constants.
  Trained on the gitignored calibration corpus (see
  `tools/calibration/README.md`). Shipping the v3 round (week 6) — v4
  (week 8) refit failed to beat v3 on the holdout.
- **A/B switch** — `cgrca rca --legacy-weights` (and
  `useLegacyWeights: true` on `buildCausalChain`) restores the
  pre-calibration constants for users who pass a known symbol and
  expect the anchor to lead.
- **Three failed attempts** at making `dataflowScore` informative —
  v2 added the feature, v3 refit after local-binding extraction,
  v4 refit after the ARG_BIND gate. All three rounds clipped the
  weight to 0. Architecture is right; the corpus shape doesn't
  exercise the signal. See the dataflow story in
  `tools/calibration/README.md`.

### New surfaces

- **`cgrcad` daemon** — see Performance.
- **MCP routing** — MCP server now connects to the daemon when
  available; per-tool calls become daemon RPCs instead of fresh
  `indexScope` runs.
- **Sentry / incident webhooks** — `cgrca-github-app` now accepts
  `POST /webhooks/sentry` and `POST /webhooks/incident`. Posts the
  ranked RCA back to the linked issue or PagerDuty incident.

### Hardening

- **Symlink-loop guard** — scope walker now tracks visited inodes;
  pathological symlink graphs no longer spin.
- **MCP request race** — fixed a race where two concurrent tool calls
  on the same repo could hand back partial results during re-index.
- **Anonymous-author handling** — `git log` rows with empty
  `author.email` no longer poison the recency hydrator.
- **Schema versioning** — `SCHEMA_VERSION` bumped to 5 (params /
  arg_bindings → v4, blob_cache → v5). Mismatches fail loudly with
  RPC error `-32002` instead of returning corrupt rows.
- **FS-order determinism** — file walk now sorts entries before
  parsing; fixes flaky test ordering and non-deterministic
  rationale-text output.

### Developer experience

- **`cgrca rca`** with no `--json` now prints a ranked candidate table
  to stdout (was: silent unless `--json`). Top-N defaults to 5.
- **`cgrca init`** gained a confirmation gate before writing to editor
  MCP configs; pass `--yes` to skip.

### Notes

- The calibration corpus (`tools/calibration/corpus.jsonl`) is
  gitignored — it's data, regenerable from any GitHub repo via
  `node tools/calibration/collect.mjs`. See
  `tools/calibration/README.md` for the bring-your-own recipe.

## [0.3.2] — 2026-05-01

### Fixed

- **`code-graph-rca-github-app`** — retry on transient 5xx and `EPIPE`
  errors when posting RCA comments. Three attempts with exponential
  backoff (1s, 2s, 4s); failures are logged but no longer crash the
  webhook handler.

## [0.3.1] — 2026-04-30

### Added

- **Local-corpus override** — autoresearch loop accepts
  `--corpus <path>` to point at a local JSONL of (failure, fix) pairs
  instead of the bundled sample. Same Sources contract.

## [0.3.0] — 2026-04-29

### Added

- **Autoresearch loop** — autonomous train→eval→keep/discard cycle on
  a fixed time budget. Advances a git branch only when the eval metric
  improves.
- **Sources contract** — every emitted candidate now carries a
  `sources: Source[]` array citing the file/line evidence behind it.
  Downstream consumers (UI, github-app) can render provenance without
  re-querying.
- **Sample corpus** for the trends eval, bundled with the package.

## [0.2.1] — 2026-05-01

### Changed

- **npm descriptions** rewritten on both `code-graph-rca` and
  `code-graph-rca-ui` to match the README + ARCHITECTURE.md framing:
  *RCA infrastructure for AI-built code, exposed via MCP / CLI /
  library.* Same code as 0.2.0.

## [0.2.0] — 2026-05-01

### Added

- **`code-graph-rca-ui`** — new package. Visual graph explorer +
  Monaco code inspector + RCA + Impact tabs. Bin: `cgrca-view`.
- **MCP server** (`cgrca mcp`) — eight tools exposed over stdio,
  native to every MCP-aware agent.
- **`cgrca init`** — one-shot setup: detects editor MCP configs,
  registers cgrca, drops AGENTS.md.
- **`CausalCandidate`** enriched with `kind`, `loc`, `subsystem`.
- **NodeNext-style import resolution** in scope walker.
- **Reverse-caller regex** updated to match basename mid-path imports.
- **Absolute Python imports** resolved against detected package roots.

### Fixed

- **Recency on monorepo subdirs** — `isGitRepo` walks parents looking
  for `.git`.
- **Anchor `recentChanges`** is now populated (was hardcoded `[]`).
- **CLI stdout drain** — `process.exitCode` instead of
  `process.exit()`. Fixes truncation past the macOS pipe buffer.

## [0.1.0] — 2026-05-01

Initial release. Headless core only.

### Added

- **Five typed query functions** — `definitionOf`, `callersOf`,
  `calleesOf`, `symbolsInFile`, `recentlyChangedNear`.
- **Scope-then-index** architecture — `resolveScope` walks the failure
  neighborhood; `indexScope` parses and loads into in-memory SQLite.
- **Two-pass tree-sitter indexing** — pass 1 extracts symbols + edges
  per file; pass 2 resolves cross-file via imports. Confidence
  1.0 / 0.7 / 0.5; unresolved targets keep their `to_name`.
- **Recency hydrator** — per-symbol `git log -L` attached as node
  metadata.
- **Causal chain ranker** — `recency × proximity × ambiguity ×
  co-change × subsystem` produces a ranked top-N candidate list.
- **Opinionated RCA prompt template** — failure context → ranked
  candidates → first hypothesis → graph context → seven-step protocol.

[0.4.0]: https://github.com/sebdenes/code-graph-rca/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/sebdenes/code-graph-rca/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/sebdenes/code-graph-rca/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/sebdenes/code-graph-rca/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/sebdenes/code-graph-rca/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sebdenes/code-graph-rca/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sebdenes/code-graph-rca/releases/tag/v0.1.0
