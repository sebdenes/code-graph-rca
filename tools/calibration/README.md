# cgrca calibration corpus

Labeled `(failure → known-correct fix location)` pairs for tuning cgrca's
causal scorer weights. Today the weights — `RECENCY_BUCKET_7=3`,
`PROXIMITY_ANCHOR=1.5`, `AMBIGUITY_4_PLUS=1.5`, `COCHANGE_PER_CLUSTER=2`,
`SUBSYSTEM_MATCH=0.5` — are hand-set vibes. This corpus is the supervision
signal for replacing them with logistic-regression-fitted coefficients.

## Files

- `corpus.jsonl` — one JSON object per line. **Gitignored** (data, not source).
  Regenerate with `node collect.mjs`.
- `collect.mjs` — mines merged "fix"/"bug" PRs (and, as a fallback, raw
  fix-style commits) from configured GitHub repos via `gh` + local `git`.
  Idempotent: reruns skip rows already present by `id`.
- `score.mjs` — runs each corpus entry through `cgrca rca` against its
  parent commit, then reports Top-1 / Top-5 hit rate, MRR, and per-signal
  correlation with hits. This is the **baseline** the calibrated model
  must beat.
- `.gitignore` — keeps `corpus.jsonl` out of git.

## Schema

```jsonc
{
  "id": "sebdenes/athlai#26",            // unique. PR rows = "<slug>#<num>",
                                          //          git-log rows = "<slug>@<sha12>"
  "repo": "sebdenes/athlai",
  "pr_number": 26,                        // null for git-log fallback rows
  "fix_commit": "0db7d877...",            // full SHA of the merge / fix commit
  "parent_commit": "<sha>",               // checkout this to reproduce the bug
  "fix_files": ["coach/tools.py", ...],   // code files changed (docs/lockfiles filtered)
  "fix_symbol": "get_activity_intervals", // primary changed symbol (highest churn file's
                                          // first hunk-context identifier)
  "fix_symbol_file": "coach/tools.py",    // file containing fix_symbol
  "all_changed_symbols": [...],           // every symbol seen in a hunk header
  "fix_summary": "fix: tool get_activity_intervals parameter mismatch",
  "failure_text": "...",                  // closing-issue body + commit body. Bounded 4000 chars.
  "cgrca_input": "symbol:get_activity_intervals", // canonical cgrca <failure> arg
  "closing_issues": [],                   // GH issue numbers the PR closed
  "source": "git-log-fallback"            // present only on fallback rows
}
```

Documented failures (we couldn't process the PR/commit) are persisted as:

```jsonc
{ "id": "...", "error": "no code files changed (docs/changelog only)" }
```

This prevents reattempts on rerun.

## How to regenerate

Requires `gh` CLI (authenticated as `sebdenes`) and local clones at:

- `/Users/I048171/code-graph-rca`
- `/Users/I048171/Athlai-Antigravity/athlai`

Then:

```bash
cd tools/calibration
rm corpus.jsonl   # only if you want a clean rebuild
node collect.mjs
```

To extend to other repos, edit the `REPOS` array at the top of `collect.mjs`.

## Source-PR list (PR-derived rows)

PR rows come from these repos' merged-fix PRs:

- `sebdenes/code-graph-rca` (1 fix PR: #2)
- `sebdenes/athlai` (13 fix PRs: #36, #31, #30, #26, #25, #24, #23, #22, #16, #13, #11, #10, #7)

The rest of the corpus (~80 rows) comes from the git-log fallback —
fix-style commits (`^(fix|bug)(\(|:|\s)`) that landed directly on `main`
without a separate PR. These are tagged `"source": "git-log-fallback"`.

## Quality bar

Each non-error row satisfies:

1. `parent_commit` is checkout-able in the local clone.
2. `fix_symbol` exists at `parent_commit` in `fix_symbol_file` (verified
   by `git show parent:file | grep -E "\bsymbol\b"`).
3. `cgrca_input` is one of cgrca's accepted `<failure>` formats
   (`symbol:<name>` for everything in this corpus).
4. `failure_text` is a free-form description sourced from the closing
   issue body (when present) or the commit body. It is **not** what we
   feed to cgrca — `cgrca_input` is. We keep `failure_text` so a future
   text-aware scorer (e.g. embedding the description against candidate
   docstrings) can use it.

## Running the baseline

```bash
node score.mjs
```

Spawns one git worktree per (repo, parent_commit), runs
`cgrca rca <cgrca_input> --json --repo <worktree>`, and computes:

- **Top-1 hit rate** — `fix_symbol` is the #1 candidate
- **Top-5 hit rate** — `fix_symbol` is in the top 5
- **MRR** — mean of `1/rank` (rank ∈ 1..10) or 0 if absent
- **Per-signal correlation** — Pearson correlation between each scoring
  signal (recencyScore, proximityScore, ambiguityScore, coChangeScore,
  subsystemScore) on the fix_symbol candidate and the binary hit outcome

Whatever next week's calibrated weights produce has to beat these
numbers (or match them with a smaller model).

## Important caveat on baseline interpretation

`cgrca_input` is `symbol:<fix_symbol>` for every row in this corpus. cgrca
treats that symbol as the investigation anchor (`distance=0`,
`role=anchor`), and the anchor almost always lands at rank 1 because of
its proximity-score boost. So the headline numbers (Top-1 = 0.911,
Top-5 = 0.970, MRR = 0.939 on the 2026-05-02 baseline) **are inflated**:
they mostly measure "does the anchor stay rank-1," not "can the scorer
find the bug from a stack trace."

For week-2 calibration we should:

1. Add a second `cgrca_input` per row that does **not** name the
   `fix_symbol` directly — e.g. a stack-trace file path, the failing test
   path, or a caller's name extracted from `failure_text`. Then re-score.
2. Train weights against rows where the anchor is _not_ the fix — those
   are the rows where signal weights actually matter.
3. The current per-signal correlations are still informative as a floor:
   `proximityScore` (0.559) and `subsystemScore` (0.559) dominate, while
   `coChangeScore` (0.052) and `recencyScore` (0.204) are nearly noise
   on this anchored set. Co-change is exactly the signal the calibrated
   model needs to prove out on harder inputs.

## Two metric tracks (post-week-2)

`collect.mjs --enrich` adds two extra fields per row:

- `cgrca_input_trace` — set when `failure_text` looks like a stack trace
  (file:line + function refs). Written to a temp file path so cgrca's
  stack-trace parser kicks in.
- `cgrca_input_caller` — `symbol:<one-hop caller of fix_symbol>` resolved
  via cgrca's own `callersOf` query at `parent_commit`. Falls back to a
  sibling symbol in the same file if no caller exists.
- `unanchored_input: null` + `unanchored_reason` — when neither shape
  works (no trace, no caller, no sibling).

Aim: ≥ 50 rows with a non-anchored input. As of 2026-05-02 enrichment:
1 trace + 61 caller + 39 sibling = 101 / 101 rows enriched.

`score.mjs --mode anchored|unanchored|both` picks which input to feed
cgrca per row:

| track       | input shape           | what it measures                         |
| ----------- | --------------------- | ---------------------------------------- |
| anchored    | `symbol:<fix_symbol>` | "does the anchor stay rank-1" (inflated) |
| unanchored  | `symbol:<caller>` / trace | the realistic case — find the bug from |
|             |                       | a non-fix starting point                  |

Pass `--dump-signals <path>` to write a JSONL of every (entry, candidate,
signals, label) tuple to `<path>`. That's the input to `fit.mjs`.

## Fitting the calibrated weights

```bash
# 1. enrich corpus (one-time after collect)
node collect.mjs --enrich

# 2. score in unanchored mode and dump signals
node score.mjs --mode unanchored --dump-signals /tmp/cgrca-signals.jsonl

# 3. fit logistic regression — prints learned multipliers and holdout metrics
node fit.mjs --dump /tmp/cgrca-signals.jsonl
```

`fit.mjs` runs batch gradient descent on a logistic regression with the
six per-signal scores as features and "is the gold candidate" as the
label. Anchor candidates are filtered out of training (the anchor is
never the gold by construction in unanchored mode). The 80/20 train /
holdout split uses seed=42 (mulberry32) for reproducibility.

Output is written to `fit.out.json` next to the script. Negative raw
weights are clipped to 0 in the production multipliers — every signal
must only *help* a candidate's score for the rationale text in
`packages/core/src/rca/causal.ts` to remain coherent.

### 2026-05-02 fit, headline numbers

Holdout (n=20, seed=42):

| weights              | top-1 | top-5 | MRR   |
| -------------------- | ----- | ----- | ----- |
| legacy (hand-set)    | 0.000 | 0.450 | 0.197 |
| learned (raw)        | 0.250 | 0.550 | 0.366 |
| learned (clipped)    | 0.200 | 0.500 | 0.317 |

Production multipliers (clipped):

```
recencyScore       0.0834
proximityScore     0.0000   (raw -1.39 → clipped; near-constant signal in
                              the non-anchor candidate set)
ambiguityScore     0.2021
coChangeScore      0.4306
subsystemScore     0.8086
complexityScore    0.4069
```

The realistic-case finding inverts the anchored-mode hypothesis:
**co-change carries the most learnable signal once you stop letting
the anchor auto-win**, while subsystem-match dominates the absolute
weight ranking. Proximity has near-zero variance among non-anchor
candidates, so the fit pushes it negative and the clip removes it.

The `--legacy-weights` CLI flag (and `useLegacyWeights: true` option on
`buildCausalChain`) preserves the original hand-set weights for users
who pass `symbol:<known-symbol>` and expect the anchor to lead.

## Known limitations

- **Symbol-to-name resolution is a heuristic.** We pull the function name
  from the diff hunk's `@@ ... @@ context` line, which depends on git's
  funcname patterns matching the language. Test files and class-level
  changes often surface the test class or class symbol rather than the
  fixed method.
- **Failure text is post-hoc.** Real failure descriptions (Sentry stack
  trace, log line, repro) live in the commit body for our repos because
  we don't open issues for our own fixes. A real production calibration
  set should pair issue-tracker bodies with PRs.
- **No PR ↔ git-log de-duplication.** A merged PR's mergeCommit is
  scanned in pass 1 (under `<slug>#<n>`); the same commit on `main` may
  reappear in pass 2 (under `<slug>@<sha>`) as a different `id`. They
  don't collide, but they double-count if you treat each row as
  independent. Filter to `source != "git-log-fallback"` for a clean
  PR-only set.
