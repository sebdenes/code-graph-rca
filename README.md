<div align="center">

# Halo

**Structural facts about your code, exposed to any AI agent over MCP.**

`code-graph-rca` · `cgrca` · MIT

</div>

When your AI agent debugs a failure in your repo, it has two ways to find the suspect code:

1. **Embedding similarity** — *"this file looks similar to your prose."* Cursor `@codebase`, GitHub Copilot, Continue, embedding RAG. Good at recall, blind to structure.
2. **Halo** — *"this function changed 2 days ago, is called from 47 places, and co-changes with the failing test in 12 of the last 30 commits."* Ground truth from your AST and git history.

Halo doesn't replace your existing retriever. It enriches it. Pair them and the agent knows both *what to look at* (embedding) and *why this is the suspect* (structure).

![Ranked causal candidates — Halo's default RCA output](docs/screenshots/02-rca.png)

## Install

```sh
npm i -g code-graph-rca            # CLI + MCP server + daemon
npm i -g code-graph-rca-ui         # Constellation / RCA / Impact viewer (optional)
npm i -g code-graph-rca-github-app # PR review + Sentry incident bot (optional)
```

## 30-second start

```sh
cd your-repo
cgrca init --yes        # detect editors, register MCP, drop AGENTS.md
cgrca daemon start      # warm queries — ~500× faster on the second hit
```

Open Cursor / Claude Code / Cody / Cline / Continue / Windsurf / Zed. Halo's MCP tools are now available to your agent. The agent reads `AGENTS.md` and knows when to call which tool.

Want a CLI demo? `cgrca rca symbol:foo` — ranked causal candidates printed as a table.

## What Halo gives an agent that embedding tools can't

Ten MCP tools, all backed by tree-sitter parsing + git + a calibrated 7-signal scorer fit by logistic regression against a labeled bug corpus:

| Tool | What it answers |
|---|---|
| `cgrca_definitionOf` | Where is this symbol declared? Returns file, line range, signature, exported flag, language, subsystem. |
| `cgrca_callersOf` | Who calls this? Reverse call tree to depth N, deduped, with confidence. |
| `cgrca_calleesOf` | What does this call? Forward call tree. Unresolved targets surface as grep-bait for the agent. |
| `cgrca_pathBetween` | How does data flow from A to B? Shortest path over CALLS + arg-binding edges. |
| `cgrca_recentlyChangedNear` | Who changed this lately? `git log -L` per symbol's lines, last N commits. |
| `cgrca_symbolsInFile` | What's in this file? Quick file-level survey. |
| `cgrca_rca` | Full ranked-candidate RCA from a stack trace / failing test / symbol / file. |
| `cgrca_rcaPrompt` | Same, but returns the assembled markdown prompt — drop straight into a reasoning loop. |
| `cgrca_rcaWithReasoning` | LLM-augmented RCA via the host's LLM (no API key needed in Claude Code). |
| `cgrca_enrichCandidates` | Take any retriever's `(file, symbol)` candidates and annotate each with body + callers + callees + recent commits. **The composability tool.** |

Plus `cgrca_scope`, `cgrca_currentSelection`, `cgrca_publishSelection` for advanced flows.

## A concrete example

Failure: *"users randomly get logged out mid-session, no error in the auth handler."*

What an embedding retriever sees: `auth/handler.py`, `session/store.py`, `middleware/cookies.py` — files containing "session," "logged out," "auth." Useful but it doesn't tell the agent which one to start at.

What Halo adds, by calling MCP tools:

- `recentlyChangedNear("SessionStore.touch")` → "Modified 6 days ago in commit `a8f3` — *'rotate session keys on idle'*."
- `callersOf("rotate_keys")` → "Called from `middleware.before_request` (2 hops upstream of every endpoint)."
- `pathBetween("Request.cookies", "rotate_keys")` → "Flows via `middleware/cookies.py:54` → `session/store.py:118`."
- The 7-signal scorer ranks `rotate_keys@session/store.py:118` at #1: high recency × short proximity to the failure surface × strong co-change with the auth subsystem.

The agent now has the structural evidence: the recent commit that rotates keys on idle is the suspect, not the auth handler the embedding retriever ranked highest.

## Three surfaces

**MCP server** — the actual product. Stdio transport, every MCP-aware editor picks it up. `cgrca init` does the wiring.

**CLI** — for scripting, CI, debugging.

```sh
cgrca rca symbol:login                                 # rank a known symbol
cgrca rca file:src/auth.py                             # rank within a file
cgrca rca test:tests/test_auth.py                      # from a failing test
cgrca rca "users randomly get logged out"              # free-text (zero-config)
cgrca rca "users randomly get logged out" --llm        # LLM re-rank (needs ANTHROPIC_API_KEY)
cgrca callers handle_login --depth 3                   # walk the call graph
cgrca define UserSession --language python             # find declarations
cgrca changed handle_login --since 30                  # who touched this lately
```

**GitHub App + incident webhook** — PR review bot posts ranked candidates as a comment; Sentry / generic webhooks open issues with ranked candidates and a first hypothesis.

## Architecture

**Scope-then-index**: a bounded BFS over imports + reverse callers picks 5–10k LOC around the failure. A two-pass tree-sitter parser builds an in-memory SQLite (or persisted with `--persist <path>`).

**Calibrated 7-signal scorer**: recency × proximity × ambiguity × co-change × subsystem × complexity × dataflow, fit by logistic regression. Tooling in [`tools/calibration/`](tools/calibration/).

**`cgrcad` daemon**: long-lived process owning one persisted SQLite per repo, keyed by realpath. Blob-sha cache skips re-parsing unchanged files; fs-watcher invalidates on edit. JSON-RPC over a unix socket. Warm queries land in ~30ms.

**Schema v7** (current): files, symbols (with `body_preview`), edges with confidence, imports, params, arg_bindings, blob_cache. Schema versioning is enforced — newer binary refuses older DBs.

Deep dive: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Performance

- 8.6× faster cold index than v0.3.x (tree-sitter query cache + blob-sha cache + FK-cascade fix).
- 91.3% Python identifier resolution (receiver-type inference resolves `self.foo()` and `obj.method()` to the right class).
- Warm queries via daemon: <50ms p95 on a real ~17k-file repo.

## Documentation

- [`CHANGELOG.md`](CHANGELOG.md) — every release, with eval numbers
- [`docs/v0.5-plan.md`](docs/v0.5-plan.md) — the plan that delivered free-text RCA + LLM augmentation, with kill criteria
- [`docs/v0.6-plan.md`](docs/v0.6-plan.md) — current plan: cgrca as the structural layer
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — scope-then-index, schema, two-pass design
- [`docs/RCA_PROTOCOL.md`](docs/RCA_PROTOCOL.md) — the seven-step protocol embedded in every Halo prompt
- [`docs/EXTENDING.md`](docs/EXTENDING.md) — adding a language
- [`packages/core/README.md`](packages/core/README.md) — engine details, all CLI flags
- [`packages/ui/README.md`](packages/ui/README.md) — Observatory viewer
- [`packages/github-app/README.md`](packages/github-app/README.md) — PR review + Sentry incidents
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — project layout, tests, coding standards

## Status

Alpha · semantic-versioned · MIT · 351 tests · schema v7 · active development.

Bug reports + PRs welcome. Eval-driven contributions especially welcome — if you can show a Halo behavior change with a top-1 / top-5 / MRR delta on a labeled corpus, it'll get serious attention.

---

<sub>*Halo* is the brand; `code-graph-rca` is the npm namespace; `cgrca` is the binary.</sub>
