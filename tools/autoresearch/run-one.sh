#!/bin/bash
# Run one autoresearch experiment.
#
# Reads tools/calibration/scoring-config.json (whatever the agent set it
# to before invoking this), rebuilds cgrca, runs the eval, prints the
# metric block.
#
# Env:
#   TARGET_REPO          repo path to evaluate against (required)
#   ANTHROPIC_API_KEY    required for llm + llm-codebase modes
#   CGRCA_LLM_MODEL      default: claude-sonnet-4-6
#   AUTORESEARCH_MODES   default: text,llm,baseline-grep
#                        (cheaper than the full 5-mode set; text is the
#                         primary signal, llm is the secondary check,
#                         grep is the floor)
#
# Cost (default modes, 9-bug corpus, sonnet): ~$0.20.
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

MODES="${AUTORESEARCH_MODES:-text,llm,baseline-grep}"
MODEL="${CGRCA_LLM_MODEL:-claude-sonnet-4-6}"

# 1. Rebuild cgrca with the current scoring-config
echo "==> rebuilding cgrca"
npm -w packages/core run build > /dev/null 2>&1

# 2. Clear any stale daemon DBs (config change invalidates indexed scores)
pkill -f cgrcad 2>/dev/null || true
rm -f "$HOME/.cgrca/repos/"*.sqlite 2>/dev/null || true

# 3. Run the eval
echo "==> running eval (modes=$MODES, model=$MODEL)"
CGRCA_LLM_MODEL="$MODEL" \
  node tools/eval/run-eval.mjs \
    --corpus tools/eval/corpus-eval-fixed.jsonl \
    --repo "$TARGET_REPO" \
    --modes "$MODES" \
    --cgrca packages/core/dist/cli.js \
    --top-n 10 \
    --timeout 180000
