# Changelog

## v0.3.0 — 2026-05-01

Three new distribution surfaces, one major release.

### Added

- **`code-graph-rca-github-app`** — new package. PR-review for cgrca with two distribution modes sharing one handler:
  - **GitHub Action** (`cgrca-pr-review` bin) — no hosting required. Runs on the PR's GitHub Actions runner. Composite action at the repo root: `uses: sebdenes/code-graph-rca@v0.3.0`.
  - **GitHub App** (`cgrca-github-app` bin) — persistent webhook server you host. One bot identity across many repos.
- **Bridge mode** — when both an MCP-aware agent and `cgrca-view` run on the same machine, they share selection state via a small live channel. Discovery via `~/.cgrca/bridge.json`.
- **New MCP tools** — `cgrca_currentSelection`, `cgrca_publishSelection`. Existing tools (`cgrca_definitionOf`, `cgrca_callersOf`, `cgrca_calleesOf`) implicitly publish focus to the bridge.
- **Server route** — `POST/GET /api/bridge/select` and `WS /api/bridge/live` on `cgrca-view`.

### Changed

- **Impact extraction** — `buildImpact` extracted from the UI server route into `packages/core/src/rca/impact.ts` and exported from the core package. UI and github-app now share one source of truth.
- **`LiveEvent` union** — extended with `{ kind: "select"; payload: ... | null }`.

### Tests

74 across the workspace (47 core + 18 UI + 9 github-app).

## v0.2.1 — 2026-05-01

### Changed

- **npm descriptions** rewritten on both `code-graph-rca` and `code-graph-rca-ui` to match the README + ARCHITECTURE.md framing: *RCA infrastructure for AI-built code, exposed via MCP / CLI / library.* Same code as 0.2.0.

## v0.2.0 — 2026-05-01

### Added

- **`code-graph-rca-ui`** — new package. Visual graph explorer (Constellation aesthetic) + Monaco code inspector + RCA + Impact tabs. Bin: `cgrca-view`.
- **MCP server** (`cgrca mcp`) — eight tools exposed over stdio, native to every MCP-aware agent (Cursor / Claude Code / Cody / Cline / Continue / Windsurf / Zed AI).
- **`cgrca init`** — one-shot setup: detects editor MCP configs, registers cgrca, drops AGENTS.md.
- **`CausalCandidate`** enriched with `kind`, `loc`, `subsystem` — UI no longer needs name-shape heuristics.
- **NodeNext-style import resolution** in scope walker (strips trailing `.js`/`.ts` suffix on relative imports).
- **Reverse-caller regex** updated to match `from "./rca/runner.js"` (basename mid-path).
- **Absolute Python imports** resolved against detected package roots.

### Fixed

- **Recency on monorepo subdirs** — `isGitRepo` walks parents looking for `.git` instead of checking only the immediate dir.
- **Anchor `recentChanges`** is now populated (was hardcoded `[]`).
- **CLI stdout drain** — `process.exitCode` instead of `process.exit()`. Fixes truncation past macOS pipe buffer when prompt grows past 8 KB.

### Tests

51 across the workspace (37 core + 14 UI server).

## v0.1.0 — 2026-05-01

Initial release. Headless core only.

### Added

- **Five typed query functions** — `definitionOf`, `callersOf`, `calleesOf`, `symbolsInFile`, `recentlyChangedNear`.
- **Scope-then-index** architecture — `resolveScope` walks the failure neighborhood; `indexScope` parses and loads into in-memory SQLite.
- **Two-pass tree-sitter indexing** — pass 1 extracts symbols + edges per file; pass 2 resolves cross-file via imports. Honest fallbacks: confidence 1.0 / 0.7 / 0.5; unresolved targets keep their `to_name`.
- **Recency hydrator** — per-symbol `git log -L` attached as node metadata.
- **Causal chain ranker** — `recency × proximity × ambiguity × co-change × subsystem` produces a ranked top-N candidate list.
- **Opinionated RCA prompt template** — failure context → ranked candidates → first hypothesis → graph context → seven-step protocol.

### Tests

37 across the workspace.
