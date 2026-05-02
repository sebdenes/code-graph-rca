#!/bin/bash
# v0.5 Phase 2 — run the eval with the LLM mode.
# Requires ANTHROPIC_API_KEY (or set CGRCA_LLM_PROVIDER=openai + OPENAI_API_KEY).
set -e
cd "$(dirname "$0")/../.."
CGRCA_LLM_MODEL="${CGRCA_LLM_MODEL:-claude-haiku-4-5-20251001}" \
  node tools/eval/run-eval.mjs \
    --corpus tools/eval/corpus-athlai-fixed.jsonl \
    --repo "${ATHLAI_REPO:-$HOME/Athlai-Antigravity/athlai}" \
    --modes text,llm,baseline-grep \
    --cgrca packages/core/dist/cli.js \
    --top-n 10 \
    --timeout 120000
