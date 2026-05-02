# tools/eval — Phase 1 eval gate

Phase 1 of the v0.5 plan (`docs/v0.5-plan.md`) ships free-text retrieval and a
fix for the broken `file:` query. This harness is the **gate** that decides
whether Phase 1 actually adds value.

**Kill criterion (from the plan):**
> If text-mode's top-1 isn't ≥2× current cgrca on this set → KG retrieval
> isn't the bottleneck, something deeper is wrong. Stop, reassess.

## Usage

```sh
# Basic — current vs. text-mode vs. file-fixed.
node tools/eval/run-eval.mjs \
  --corpus tools/eval/corpus.jsonl \
  --repo /path/to/athlai \
  --modes current,text,file

# Add the naive baseline cgrca needs to beat.
node tools/eval/run-eval.mjs \
  --corpus tools/eval/corpus.jsonl \
  --repo /path/to/athlai \
  --modes current,text,file,baseline-grep

# Smoke test on first 3 entries.
node tools/eval/run-eval.mjs \
  --corpus tools/eval/corpus.jsonl \
  --repo /path/to/athlai \
  --limit 3
```

Output:

```
Mode           Top-1  Top-5  MRR    n   skip  err  avg_ms
current        0.150  0.500  0.260  20  0     0    1240
text           0.350  0.700  0.480  20  0     0    1310
file           0.420  0.780  0.570  20  0     0    980
baseline-grep  0.100  0.300  0.180  20  0     0    320

Phase 1 kill criterion (text >= 2x current top-1): PASS (ratio=2.33, current=0.150, text=0.350)
```

A JSON dump of every per-entry result is written to
`tools/eval/eval-results-<timestamp>.json` (see `--out` to override).

## Modes

| Mode             | Input passed to cgrca           | What it measures                                        |
| ---------------- | ------------------------------- | ------------------------------------------------------- |
| `current`        | raw `failure_description`       | Today's cgrca on prose. Pre-Phase-1, expected ~0.       |
| `text`           | raw `failure_description`       | Phase 1's text-mode. Expected ≥2× `current`.            |
| `file`           | `file:<fix_files[0]>`           | Upper bound: given the right file, can cgrca rank the right symbol? |
| `baseline-grep`  | (no cgrca; uses `grep -rIlF`)   | Naive baseline: tokenize → grep → rank files by hits.   |

`current` and `text` send identical inputs because Phase 1 ships text-mode as
the **default** dispatch when the input doesn't match `symbol:`/`file:`/`test:`/
stack-trace shapes — there's no opt-in flag. So once Phase 1 lands they will
report the same numbers, which is the point: the comparison the plan cares
about is `cgrca-of-today` vs. `cgrca-of-yesterday` measured on the same
corpus. To get them differentiated **before** Phase 1 ships (e.g. while the
other agent is iterating behind a flag), set:

```sh
CGRCA_TEXT_FLAG=--experimental-text node tools/eval/run-eval.mjs ...
```

The harness will append that flag only to `text`-mode invocations.

## Corpus format

A different agent owns `corpus.jsonl`. One JSON object per line:

```json
{
  "id": "athlai#1234",
  "failure_description": "cyclist marathon training plan generates negative rest days when distance < 5km",
  "fix_files": ["src/training/plan_generator.py"],
  "fix_symbols": ["compute_rest_days"]
}
```

Required fields:
- `failure_description` (string, non-empty) — the cold-start prose the user
  would actually paste.
- At least one of `fix_files[]` or `fix_symbols[]` — what the merged fix
  actually touched. Used as ground truth for hit-rate.

Optional:
- `id` — stable identifier for logs. Falls back to `lineN` if absent.
- Anything else (e.g. `pr_url`, `parent_commit`) is preserved but unused.

Lines beginning with `#` or `//` and blank lines are skipped. Malformed JSON
lines log a warning and are skipped (the eval doesn't crash on a bad row).

## Match logic

A candidate hits if either:
- `candidate.file` matches a `fix_files[i]` — exact normalized match, or one
  is a path-suffix of the other (defensive for absolute vs. relative
  mismatches).
- `candidate.name` matches a `fix_symbols[i]` — exact, or trailing component
  match (`Class.method` == `method`, `mod#fn` == `fn`).

Top-1 = rank-1 hit. Top-5 = hit anywhere in ranks 1–5. MRR = `1/rank` when
there's a hit in ranks 1–10, else 0.

## Robustness notes

- Each `cgrca rca` subprocess is time-capped at 30s (`--timeout`).
- If cgrca crashes or times out on an entry, that (entry, mode) row is logged
  as `err` and the eval continues.
- Entries missing `failure_description` or both fix lists are skipped with a
  warning before any cgrca call.
- A 30-entry corpus across 3 modes should run in well under 10 minutes (the
  `file` mode is fastest; `current`/`text` are bounded by cgrca's own runtime).

## Files

- `run-eval.mjs` — the harness (no npm deps; Node + `cgrca` subprocess +
  `grep` for the baseline).
- `corpus.jsonl` — produced by the bug-corpus agent. Gitignored (data, not
  source).
- `eval-results-*.json` — per-run output. Gitignored.
