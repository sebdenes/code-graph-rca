# cgrca calibration corpus

Labeled `(failure → known-correct fix location)` pairs for tuning cgrca's
causal scorer weights. The corpus replaces hand-set "vibes" weights with
logistic-regression-fitted coefficients, A/B-able via the
`--legacy-weights` CLI flag.

## Files

- `corpus.jsonl` — one JSON object per line. **Gitignored** (data, not
  source). Regenerate with `node collect.mjs`.
- `collect.mjs` — mines merged "fix"/"bug" PRs (and, as a fallback, raw
  fix-style commits) from configured GitHub repos via `gh` + local `git`.
  Idempotent: reruns skip rows already present by `id`.
- `score.mjs` — runs each corpus entry through `cgrca rca` against its
  parent commit, then reports Top-1 / Top-5 hit rate, MRR, and per-signal
  correlation with hits.
- `fit.mjs` — batch-gradient logistic regression over the dumped signals.
- `fit.out.json` — last fit's learned multipliers + holdout metrics.

## Schema

```jsonc
{
  "id": "<owner>/<repo>#<num>",           // PR rows. git-log rows = "<slug>@<sha12>"
  "repo": "<owner>/<repo>",
  "pr_number": 26,                         // null for git-log fallback rows
  "fix_commit": "0db7d877...",
  "parent_commit": "<sha>",                // checkout this to reproduce the bug
  "fix_files": ["pkg/module.py", ...],     // code files changed (docs/lockfiles filtered)
  "fix_symbol": "<name>",                  // primary changed symbol
  "fix_symbol_file": "pkg/module.py",
  "all_changed_symbols": [...],
  "fix_summary": "fix: ...",
  "failure_text": "...",                   // closing-issue body + commit body, ≤4000 chars
  "cgrca_input": "symbol:<name>",
  "closing_issues": [],
  "source": "git-log-fallback"             // present only on fallback rows
}
```

Documented failures (the row could not be processed) are persisted as
`{ "id": "...", "error": "..." }` so reruns skip them.

## Bring-your-own-corpus

The corpus is gitignored on purpose — calibration is repo-specific signal,
not source. To build one against any GitHub repo you have local access to:

```bash
# 1. clone the repo locally; ensure `gh` is authenticated
# 2. add the repo to the REPOS array at the top of collect.mjs:
#       { slug: "<owner>/<repo>", path: "/abs/path/to/local/clone" }
# 3. mine fix-PRs and fix-style commits
node tools/calibration/collect.mjs

# 4. enrich with non-anchor inputs (caller / sibling / trace)
node tools/calibration/collect.mjs --enrich
```

Real-world Python repos with a few years of `fix:`-prefixed commits and
closing-issue references give the densest signal.

## Calibration history

Every round runs the same loop: collect → enrich → score → dump signals
→ fit. The "gate met?" column is `top-1 (calibrated) > top-1 (legacy)`
on the unanchored holdout.

| round | date       | gate met? | what changed                                       |
| ----- | ---------- | --------- | -------------------------------------------------- |
| v1    | week 3     | yes       | first LR fit. 6 signals (no dataflow). proximity   |
|       |            |           | clipped to 0 (near-constant on non-anchor set).    |
| v2    | week 5     | yes       | adds `dataflowScore` as a 7th feature (week-4 ship |
|       |            |           | of the dataflow agent). dataflow weight clipped.   |
| v3    | week 6     | yes       | refit after local-binding extraction lifted        |
|       |            |           | resolution from 22.8% → ~50% on Python. dataflow   |
|       |            |           | still clipped — see "dataflow story" below.        |
| v4    | week 8     | no        | refit after week-7 ARG_BIND gate landed. v3 weights|
|       |            |           | held; v4 did not beat v3 on the holdout. v3 ships. |

### Key takeaways across rounds

- **`subsystemScore` and `coChangeScore` carry the most learnable signal**
  once the anchor's auto-win is stripped (unanchored mode).
- **`proximityScore` has near-zero variance** among non-anchor candidates;
  every round's LR pushes it negative and the production clip removes it.
- **`dataflowScore` ships at weight 0** across v2/v3/v4 — see below.

## The dataflow story (3 attempts, 3 clips)

Architecturally the dataflow signal is right: a CALLS+arg-binding path
back to the anchor *should* discriminate gold from bystander. Empirically
on this corpus it does not, across three rounds:

- **v2 (week 5).** Dataflow added as a feature. Per-gold Pearson r=0.736
  (highest of any signal) but per-candidate r=-0.07: the path back to the
  anchor exists for many topology-neighbor bystanders too. LR weight goes
  negative; production clip → 0.
- **v3 (week 6).** Local-binding extraction lifted resolution from
  22.8% → ~50% on Python. Hypothesis: cleaner provenance differentiates
  gold from generic reachability. Result: still clipped. The added
  `kind='local'` edges are good but the corpus's bystander rate did not
  drop enough.
- **v4 (week 8).** ARG_BIND gate (week 7) tightened arg-binding emission
  to only fire when the source is a `kind='param'` or `kind='local'`
  that's actually consumed at the call. Refit. Result: still clipped; v4
  failed to beat v3 on holdout, v3 weights are still production.

**Read:** the architecture is right; the corpus shape doesn't exercise
the signal. The realistic-failure inputs we generate (`symbol:<caller>`,
sibling fallback) put the gold one or two hops from the anchor — well
within reach of the cheaper topology signals. A future corpus mining
deeper failure paths (multi-frame stack traces, cross-package callers) is
the cleanest route to a non-zero dataflow weight.

## Recipe (the canonical fit loop)

```bash
# 1. enrich (one-time after a fresh collect)
node tools/calibration/collect.mjs --enrich

# 2. score in unanchored mode and dump signals
node tools/calibration/score.mjs --mode unanchored \
  --dump-signals /tmp/cgrca-signals.jsonl

# 3. fit logistic regression — prints learned multipliers + holdout metrics
node tools/calibration/fit.mjs --dump /tmp/cgrca-signals.jsonl
```

### The signal-cache trap

`fit.mjs` reads from `/tmp/cgrca-signals.jsonl` by default. `score.mjs`
**only writes** when you pass `--dump-signals`. If you tweak the scorer
in `packages/core/src/rca/causal.ts` and re-run `fit.mjs` without first
re-running `score.mjs --dump-signals`, you are fitting on stale features.
Symptom: the holdout numbers don't move when they should.

Fix: always pair `score.mjs --dump-signals <path>` with
`fit.mjs --dump <path>`. Use distinct paths if you're A/B-ing.

## Running the baseline

```bash
node tools/calibration/score.mjs
```

Spawns one git worktree per (repo, parent_commit), runs
`cgrca rca <cgrca_input> --json --repo <worktree>`, and computes:

- **Top-1 hit rate** — `fix_symbol` is the #1 candidate
- **Top-5 hit rate** — `fix_symbol` is in the top 5
- **MRR** — mean of `1/rank` (rank ∈ 1..10) or 0 if absent
- **Per-signal correlation** — Pearson correlation between each scoring
  signal and the binary hit outcome

## Anchored vs unanchored tracks

`cgrca_input` defaults to `symbol:<fix_symbol>`. cgrca treats that as
the investigation anchor (`distance=0`, `role=anchor`) and the anchor
almost always lands at rank 1 because of its proximity-score boost.
Headline anchored numbers (top-1 ≈ 0.91 on this corpus) are inflated:
they measure "does the anchor stay rank-1," not "can the scorer find the
bug from a stack trace."

`collect.mjs --enrich` adds two extra inputs per row:

- `cgrca_input_trace` — set when `failure_text` looks like a stack trace.
- `cgrca_input_caller` — `symbol:<one-hop caller of fix_symbol>` resolved
  via cgrca's own `callersOf` query at `parent_commit`. Falls back to a
  sibling symbol in the same file if no caller exists.

`score.mjs --mode anchored|unanchored|both` picks which input to feed:

| track       | input shape               | what it measures                         |
| ----------- | ------------------------- | ---------------------------------------- |
| anchored    | `symbol:<fix_symbol>`     | "does the anchor stay rank-1" (inflated) |
| unanchored  | `symbol:<caller>` / trace | the realistic case — find the bug from a |
|             |                           | non-fix starting point                   |

## Production weights (v3, currently shipping)

```
recencyScore       0.1815
proximityScore     0.0000   (clipped from negative)
ambiguityScore     0.0820
coChangeScore      0.5108
subsystemScore     0.7840
complexityScore    0.3136
dataflowScore      0.0000   (clipped, 3 rounds running)
```

Negative raw weights are clipped to 0 in production: every signal must
only *help* a candidate's score for the rationale text in
`packages/core/src/rca/causal.ts` to remain coherent. The
`--legacy-weights` CLI flag (and `useLegacyWeights: true` option on
`buildCausalChain`) preserves the original hand-set weights for users who
pass `symbol:<known-symbol>` and expect the anchor to lead.

## Known limitations

- **Symbol-to-name resolution is a heuristic.** We pull the function name
  from the diff hunk's `@@ ... @@ context` line, which depends on git's
  funcname patterns matching the language. Test files and class-level
  changes often surface the test class or class symbol rather than the
  fixed method.
- **Failure text is post-hoc.** Real failure descriptions (Sentry stack
  trace, log line, repro) live in the commit body for repos that don't
  open issues for their own fixes. A real production calibration set
  should pair issue-tracker bodies with PRs.
- **No PR ↔ git-log de-duplication.** A merged PR's mergeCommit is
  scanned in pass 1 (under `<slug>#<n>`); the same commit on `main` may
  reappear in pass 2 (under `<slug>@<sha>`). They don't collide but they
  double-count if you treat each row as independent. Filter to
  `source != "git-log-fallback"` for a clean PR-only set.
