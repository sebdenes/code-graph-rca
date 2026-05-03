# Changelog

All notable changes to **code-graph-rca** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-05-03

cgrca now accepts prose / partial-trace failure descriptions and
(optionally) re-ranks the top candidates with an LLM. **Honest
positioning** (re-framed late in v0.5 after the eval came in): cgrca
is the **structural layer** for code-RCA — graph + git signals that
embedding-based retrievers can't have — not a replacement for those
retrievers. The free-text and `--llm` flows ship as zero-config
fallbacks; the long-term value is in the MCP tools that enrich any
retriever's candidates with cgrca's structural signals.

### What's new

- **`cgrca rca <free-text>`** — prose / partial-trace input now routes
  to a tokenizer + multi-anchor matcher (substring + camelCase ↔
  snake_case + body content) instead of collapsing to symbol lookup.
  Returns ranked candidates where Phase 0 returned 0. (PR #27)
- **`--llm` flag** — opt-in LLM re-rank. Provider abstraction:
  Anthropic (default) + OpenAI-compatible (Together / Groq / local
  llama.cpp via `OPENAI_BASE_URL`). Per-call $/cost surfaced honestly.
  Default model: `claude-sonnet-4-6`. (PR #29)
- **Schema v7 — body indexing** — `symbols.body_preview` captures the
  first 30 lines of every function/class body at parse time. The
  textmode matcher searches body content for length-≥8 prose tokens
  (length guard prevents common-word noise from displacing
  precision). (PR #34)
- **Matcher tail augmenter** — surfaces substring-only candidates
  that lost the seed-driven graph walk race. (PR #31)
- **`@codebase`-style baseline + Phase 4 kill criterion** —
  `tools/eval/llm-codebase-baseline.mjs` + `llm-codebase` mode. Lets
  anyone run `bash tools/eval/run-llm.sh` and compare cgrca's `--llm`
  against an embedding-style retriever on a labelled corpus. Honest
  measurement infrastructure ships with the feature. (PR #31)
- **MCP tool `cgrca_rcaWithReasoning`** — returns the LLM-ready
  prompt as a single text block; the host LLM (Claude in Claude Code,
  etc.) reasons over it inline. **No API key required.** (PR #32)

### Eval results (athlai 8-bug corpus, 2026-05-03)

| Mode | Top-1 | Top-5 | MRR | Cost / 8 bugs |
|---|---|---|---|---|
| baseline-grep | 0.375 | 0.625 | 0.494 | $0 |
| text (cgrca free-text + matcher widening + body) | 0.500 | 0.625 | 0.575 | $0 |
| **cgrca `--llm` Sonnet** | **0.750** | 0.750 | 0.750 | $0.16 |
| llm-codebase (BM25 + Sonnet) | **0.875** | 0.875 | 0.875 | $0.27 |

cgrca `--llm` lifts top-1 by +37.5pp over naive grep. **It does NOT
beat the @codebase-style baseline** by the v0.5 plan's pre-committed
≥10pp threshold (gap is -12.5pp, not +10pp). The honest read: for the
1 bug where llm-codebase wins (pr22-telegram-markdown), cgrca's fix
file was past the `--max-files=200` budget; with budget bumped, cgrca
also finds it at #1 — but the wider scope regresses other bugs because
the static scorer is calibrated for ~200-file scope.

**This isn't a failure of the graph.** It's a failure of trying to be
a retriever. The graph + git signals add real value when wrapped
around a retriever's output, not when used as the retriever itself.
See "Long-term direction" below.

### Long-term direction (v0.6 and beyond)

The eval pre-commitment said "if `--llm` doesn't beat @codebase by
≥10pp, pivot or stop." The honest pivot: **stop competing with
embedding retrievers, start enriching them.**

cgrca's actual moat is in the signals embedding retrievers can't
have:

- Call graph (callersOf, calleesOf, pathBetween)
- Git signal (recentlyChangedNear, co-change history per symbol)
- Calibrated scoring (recency × proximity × ambiguity × co-change ×
  subsystem × complexity × dataflow — already fit by logistic
  regression against a labelled corpus)
- Per-repo persistence + fs-watch invalidation
- MCP integration in every agent that matters

These are **ground truth from AST + git**, not approximate from
embeddings. Tools like Cursor's `@codebase` will always have better
embeddings, more aggressive caching, and no file budget — but they
can't tell you *"this function changed 2 days ago, is called from 47
places, and co-changes with the failing test in 12 of the last 30
commits."*

v0.6 ships:

- `cgrca_enrichCandidates` MCP tool — accepts `(file, symbol)`
  candidates from ANY retriever (Cursor, Copilot, Continue,
  embedding-RAG, …) and returns them annotated with cgrca's 7
  calibrated signals + neighborhood + body previews + recent commits
- Phase 5 self-improvement loop — per-repo `(failure, fix)`
  observation log → calibrate signal weights per repo → cgrca's
  ranking gets *better over time*. **Embedding retrievers can't
  replicate this** — they don't keep per-repo persistent observation
  substrate; cgrca does.

`--llm` and free-text RCA stay shipped as zero-config fallbacks for
users without their own retriever wired in. They're not the headline.

### Honest framing — what to say (and not say)

- ✅ "cgrca is the structural layer for code-RCA. Graph + git signals
  that embedding tools fundamentally can't have."
- ✅ "Pair cgrca with your existing retriever (Cursor, Copilot,
  Continue) for best results."
- ✅ "Built-in `--llm` flow is a zero-config fallback for users
  without an existing retriever."
- ❌ "GraphRAG specialised for code-RCA beats embedding retrieval."
  (Eval says it doesn't.)
- ❌ "cgrca `--llm` is the best RCA pipeline." (Use of "best" is
  unsupported by current evidence on this corpus.)

### Internal

- Schema bumped v6 → v7 (`symbols.body_preview` column added).
  Existing `~/.cgrca/repos/*.sqlite` will be rejected with "expects
  v7" — `rm` to force re-index.
- Walker drift fixes in `scope.ts`, `resolve.ts`, `runner.ts` —
  `.gitignore` was being ignored in three different scanners,
  indexing noise dirs (`.claude/`, `.agent/`, `.ruff_cache/`) before
  reaching real source. (PR #27)
- 28 new tests across textmode, llm/body, llm/prompt, llm/provider,
  splitCompound, substring matching, body content. 351/351 total pass.
- `tools/eval/run-eval.mjs` grew `llm` and `llm-codebase` modes with
  per-call $/latency tracking and a Phase 4 kill-criterion line.
- CI fixes: vite8/rolldown native bindings (`npm/cli#4828`), TypeScript
  6 baseUrl deprecation, React 19 RefObject + JSX namespace migration.
  (PR #28)
- IDF + path-priority + walker-prioritization experiments tried during
  the post-Phase-4 iteration; all reverted (didn't lift on this corpus).
  Notes preserved in `project_v05_phase4_kill_criterion_failed.md`.

### Breaking

- Default behaviour of `cgrca rca <bare-input>` changed: prose now
  routes to the free-text path instead of collapsing to symbol lookup.
  Legacy behaviour preserved behind `--legacy-parse`. (PR #27)
- Schema bumped v6 → v7. Existing daemon DBs at `~/.cgrca/repos/*`
  rejected with "expects v7" — `rm` to force re-index.

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
