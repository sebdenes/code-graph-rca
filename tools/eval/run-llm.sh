#!/bin/bash
# v0.5 Phase 2 + 4 — full eval with both LLM modes.
# Modes:
#   text          — static cgrca free-text retrieval (no LLM)
#   llm           — cgrca free-text retrieval + LLM re-rank (Phase 2)
#   llm-codebase  — @codebase-style baseline: BM25 over file content + LLM (Phase 4 gate)
#   baseline-grep — naive grep
#
# Requires ANTHROPIC_API_KEY (or set CGRCA_LLM_PROVIDER=openai + OPENAI_API_KEY).
# Default model: claude-sonnet-4-6 (override with CGRCA_LLM_MODEL).
#
# Cost (8-bug Python corpus, sonnet): ~$0.30 (llm $0.15 + llm-codebase ~$0.15).
set -e
cd "$(dirname "$0")/../.."
CGRCA_LLM_MODEL="${CGRCA_LLM_MODEL:-claude-sonnet-4-6}" \
  node tools/eval/run-eval.mjs \
    --corpus tools/eval/corpus-eval-fixed.jsonl \
    --repo "${TARGET_REPO:-$HOME/target-repo}" \
    --modes text,llm,llm-codebase,baseline-grep \
    --cgrca packages/core/dist/cli.js \
    --top-n 10 \
    --timeout 180000
