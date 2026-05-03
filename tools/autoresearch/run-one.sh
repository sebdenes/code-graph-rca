#!/bin/bash
# Run one autoresearch experiment.
#
# Reads tools/calibration/scoring-config.json (whatever the agent set it
# to before invoking this), rebuilds cgrca, runs the eval, prints the
# metric block.
#
# Default modes are text + grep — both FREE (no API key, no network).
# The autoresearch loop's primary signal is `text` top-1; that's the
# only mode that responds to scoring-config changes. `llm` and
# `llm-codebase` modes don't read this config and won't move regardless,
# so they're skipped by default. Set AUTORESEARCH_MODES to override
# (e.g. for a final validation pass against the LLM modes).
#
# Env:
#   TARGET_REPO          repo path to evaluate against (required)
#   AUTORESEARCH_MODES   default: text,baseline-grep (free, ~30s per run)
#                        Override to include llm + llm-codebase if you
#                        want the full picture, but they cost ~\$0.30/run
#                        and don't help the autoresearch decision.
#   ANTHROPIC_API_KEY    only needed if you override modes to include llm*
#   CGRCA_LLM_MODEL      only used if llm* modes are in AUTORESEARCH_MODES
#
# Cost (default modes): \$0. Wall time: ~30s per experiment.
# 30 experiments = ~15 min, \$0. Run autoresearch in your Claude Code
# session for free.
set -e
cd "$(dirname "$0")/../.."

if [ -z "$TARGET_REPO" ]; then
  echo "TARGET_REPO must be set to the repo path you're evaluating against" >&2
  exit 2
fi
if [ ! -d "$TARGET_REPO" ]; then
  echo "TARGET_REPO is not a directory: $TARGET_REPO" >&2
  exit 2
fi

MODES="${AUTORESEARCH_MODES:-text,baseline-grep}"
MODEL="${CGRCA_LLM_MODEL:-claude-sonnet-4-6}"

# 1. Rebuild cgrca with the current scoring-config
echo "==> rebuilding cgrca"
npm -w packages/core run build > /dev/null 2>&1

# 2. Clear any stale daemon DBs (config change invalidates indexed scores)
pkill -f cgrcad 2>/dev/null || true
rm -f "$HOME/.cgrca/repos/"*.sqlite 2>/dev/null || true

# 3. Run the eval
echo "==> running eval (modes=$MODES)"
CGRCA_LLM_MODEL="$MODEL" \
  node tools/eval/run-eval.mjs \
    --corpus tools/eval/corpus-eval-fixed.jsonl \
    --repo "$TARGET_REPO" \
    --modes "$MODES" \
    --cgrca packages/core/dist/cli.js \
    --top-n 10 \
    --timeout 90000
