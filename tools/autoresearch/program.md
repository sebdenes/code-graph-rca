# cgrca autoresearch program

You are running an autoresearch loop on cgrca's scoring config from
inside a Claude Code session. Your goal: find values in
`tools/calibration/scoring-config.json` that maximise text-mode top-1 on
the labeled eval corpus, without regressing the other metrics.

The loop is **free** — no Anthropic API calls, no \$ cost. Each
experiment is just `bash tools/autoresearch/run-one.sh`, which rebuilds
cgrca, runs the eval against text mode + grep (both no-LLM), and prints
the metric. ~30 seconds per experiment. 30 experiments = ~15 minutes.

YOU are the agent. You read this program, edit the scoring config, run
the eval, decide keep/discard, repeat. Your subscription covers it.

This file (`program.md`) is the only thing the human iterates on. The
scoring config is the only thing **you** iterate on. Don't touch source
code.

## How to run one experiment

1. Read `tools/autoresearch/best.json` to know the current best metric and
   which config produced it. If no `best.json` exists yet, the current
   `tools/calibration/scoring-config.json` is the baseline; copy it there
   and treat its eval result as the baseline metric.
2. Edit `tools/calibration/scoring-config.json`. Change ONE knob per
   experiment unless you have a written hypothesis why two should move
   together — small, isolated changes are easier to attribute. Reasonable
   step sizes: weights ±10–30%, length thresholds ±1, integer caps ±25–50%.
3. Run `bash tools/autoresearch/run-one.sh` from the repo root. It rebuilds
   cgrca and runs the eval; takes ~3 min and ~$0.30.
4. Read the printed metric block. Compare against the current best in
   `best.json`.
5. If `text` mode top-1 improved by ≥1pp AND no other mode regressed by
   >2pp, **keep**: copy the current config into `best.json`'s `config`
   field, update `best.json`'s metrics, and append a row to
   `tools/autoresearch/log.jsonl`. Continue.
6. If not improved, **discard**: copy `best.json`'s config back to
   `tools/calibration/scoring-config.json` so the next experiment starts
   from the current best. Append a discarded row to `log.jsonl`. Continue.

## What to optimise

**Only metric**: `text` mode top-1.

Why text-only: it's the only mode that responds to changes in
`scoring-config.json`. The `llm` and `llm-codebase` modes don't read
this config — they would just produce identical numbers across all
experiments and waste \$ + time on every run.

Tiebreaker: MRR (also from text mode).
Sanity check: don't let text top-5 regress by >2pp.

After 30 experiments OR when you stop, you can OPTIONALLY run one final
validation pass with `AUTORESEARCH_MODES=text,llm,baseline-grep bash
tools/autoresearch/run-one.sh` to confirm the LLM-mode metric also
held / improved. That single run costs ~\$0.20.

## Knobs by leverage (rough guide)

These are the autoresearch agent's prior on what matters. Not gospel —
the agent should explore beyond.

**High leverage — try these first:**
- `matcher.body_content_weight` (current 0.3): sub-words searching function
  bodies. Bumping helps recall on bugs whose failure prose matches body
  content (`asterisks` → `_strip_markdown`'s `re.sub(r'[*_~`]')`).
- `matcher.body_content_min_length` (current 8): only tokens ≥ N chars
  search bodies. Lowering broadens recall but adds noise; raising tightens.
- `matcher.subname_match_weight` (current 1.0): substring name match —
  the camelCase ↔ snake_case bridge.
- `retrieval.free_text_seed_cap` (current 8): how many anchor seeds for
  the multi-anchor walk. Bigger = more diverse coverage, smaller = sharper.

**Medium leverage:**
- `scorer.calibrated_weights.recency` / `coChange` / `subsystem`: 7-signal
  causal scorer weights, fit by logistic regression on a separate corpus.
  Re-tuning may help on this corpus' bug shapes.
- `augmenter.matcher_tail_topn_multiplier` (current 5): how wide the
  matcher-tail augmenter goes. Wider = more candidates the LLM sees,
  better recall but more noise.
- `matcher.signature_match_weight` (current 2.0): literal-in-signature
  match. Less leverage than body but cleaner signal.

**Low leverage / exotic:**
- `matcher.subwords_per_token_ceiling` (current 3): the score ceiling
  computation. Touching this reshapes normalisation, not direct score.
- `scorer.calibrated_weights.dataflow` (current 0.0): dataflow signal,
  fit to zero in v0.4 calibration. Bumping is essentially testing
  whether the signal has *any* discriminative power; usually no.

## When to stop

- 30 experiments completed
- OR no improvement in 10 consecutive experiments (you're stuck in a basin)
- OR the user interrupts

(No \$ budget — text-mode eval is free.)

When stopping, print a markdown summary: best config, best metrics
(text top-1, top-5, MRR), total experiments, top 3 contributing knob
changes, knobs marked saturated. Optionally run the LLM-mode validation
pass per the section above.

## Hard constraints

- Touch ONLY `tools/calibration/scoring-config.json`. Never modify
  `packages/core/`, `tools/eval/`, or anything else.
- The eval corpus is held-out. Never look at per-bug results to handcraft
  a config that wins one specific bug; only optimise against the
  aggregate metric.
- If you're tempted to change two knobs in the same experiment, write a
  one-sentence hypothesis FIRST in `log.jsonl`'s notes field, then do it.
- If a knob has been tried at 5+ values without improvement, mark it
  saturated by appending its name to `tools/autoresearch/saturated.txt`
  and don't touch it again this run.

## Output schema (best.json)

```json
{
  "metrics": {
    "text_top1": 0.444,
    "text_top5": 0.667,
    "text_mrr": 0.548,
    "llm_top1": 0.778,
    "llm_top5": 0.778,
    "llm_mrr": 0.778
  },
  "config": { ...the config that produced these metrics... },
  "experiment_id": 17,
  "timestamp": "2026-05-04T03:42:00Z"
}
```

## Output schema (log.jsonl, append-only)

```jsonl
{"id": 1, "ts": "...", "knob": "matcher.body_content_weight", "before": 0.3, "after": 0.5, "metric_before": 0.444, "metric_after": 0.444, "kept": false, "notes": "..."}
{"id": 2, "ts": "...", "knob": "matcher.body_content_weight", "before": 0.3, "after": 0.1, "metric_before": 0.444, "metric_after": 0.556, "kept": true, "notes": "lower body weight reduced noise on cyclist + pr25"}
```
