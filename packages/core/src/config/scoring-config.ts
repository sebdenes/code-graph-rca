/**
 * Single editable surface for the v0.7 autoresearch loop.
 *
 * Every weight + threshold the scorer (causal.ts) and matcher (textmode.ts)
 * use is sourced from `scoring-config.json`. The autoresearch agent edits
 * that JSON; nothing else. See docs/v0.7-plan.md for the loop.
 *
 * Resolution order:
 *   1. Path in env var `CGRCA_SCORING_CONFIG`
 *   2. `<cwd>/tools/calibration/scoring-config.json`
 *   3. Bundled defaults (this file's `DEFAULT_SCORING_CONFIG`)
 *
 * The bundled defaults match the v0.5.0 hardcoded constants exactly, so
 * no config file = identical behavior to before this refactor. The
 * autoresearch loop runs against (2): the agent edits the file, runs the
 * eval, keeps if metric improved.
 *
 * Read once at first access, cached. No file watcher — the autoresearch
 * loop ends and restarts the cgrca process for each experiment, so a
 * cached read is correct.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ScoringConfig {
  matcher: {
    name_match_weight: number;
    subname_match_weight: number;
    signature_match_weight: number;
    body_content_weight: number;
    import_match_weight: number;
    subwords_per_token_ceiling: number;
    substring_name_min_length: number;
    substring_name_min_symbol_length: number;
    substring_name_per_token_cap: number;
    signature_substring_min_length: number;
    body_content_min_length: number;
  };
  scorer: {
    calibrated_weights: ScorerWeights;
    legacy_weights: ScorerWeights;
  };
  augmenter: {
    matcher_tail_topn_multiplier: number;
    matcher_tail_floor: number;
  };
  retrieval: {
    default_max_files: number;
    default_top_n: number;
    free_text_seed_cap: number;
  };
}

export interface ScorerWeights {
  recency: number;
  proximity: number;
  ambiguity: number;
  coChange: number;
  subsystem: number;
  complexity: number;
  dataflow: number;
}

/**
 * Defaults are kept in lock-step with `tools/calibration/scoring-config.json`
 * so the bundled package works without the JSON present (e.g. when the
 * core package is consumed as a library outside this repo).
 */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  matcher: {
    name_match_weight: 3.0,
    subname_match_weight: 1.0,
    signature_match_weight: 2.0,
    body_content_weight: 0.3,
    import_match_weight: 0.5,
    subwords_per_token_ceiling: 3,
    substring_name_min_length: 4,
    substring_name_min_symbol_length: 5,
    substring_name_per_token_cap: 100,
    signature_substring_min_length: 5,
    body_content_min_length: 8,
  },
  scorer: {
    calibrated_weights: {
      recency: 0.0766,
      proximity: 0.0,
      ambiguity: 0.2133,
      coChange: 0.4744,
      subsystem: 0.8909,
      complexity: 0.1679,
      dataflow: 0.0,
    },
    legacy_weights: {
      recency: 1.0,
      proximity: 1.0,
      ambiguity: 1.0,
      coChange: 1.0,
      subsystem: 1.0,
      complexity: 1.0,
      dataflow: 1.0,
    },
  },
  augmenter: {
    matcher_tail_topn_multiplier: 5,
    matcher_tail_floor: 25,
  },
  retrieval: {
    default_max_files: 200,
    default_top_n: 5,
    free_text_seed_cap: 8,
  },
};

let _cached: ScoringConfig | null = null;
let _cachedSource: string | null = null;

/**
 * Read once, cache. Subsequent calls return the cached config. Reset via
 * {@link _resetScoringConfigCache} for tests.
 */
export function getScoringConfig(): ScoringConfig {
  if (_cached) return _cached;
  const { config, source } = loadScoringConfig();
  _cached = config;
  _cachedSource = source;
  return config;
}

/** Where the current config came from. Useful for `cgrca config show`. */
export function getScoringConfigSource(): string {
  if (!_cached) {
    void getScoringConfig();
  }
  return _cachedSource ?? "(uninitialized)";
}

/** @internal — test-only. Drops the cache so the next get re-reads. */
export function _resetScoringConfigCache(): void {
  _cached = null;
  _cachedSource = null;
}

function loadScoringConfig(): { config: ScoringConfig; source: string } {
  const envPath = process.env.CGRCA_SCORING_CONFIG;
  const cwdPath = resolve(process.cwd(), "tools", "calibration", "scoring-config.json");
  const candidates = [envPath, cwdPath].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as Partial<ScoringConfig>;
      const merged = mergeWithDefaults(parsed);
      return { config: merged, source: path };
    } catch (err) {
      // Malformed JSON or read failure — log to stderr (so callers see it),
      // fall through to defaults rather than crash. Autoresearch agents
      // can write a malformed file; we want a clear signal, not a panic.
      process.stderr.write(
        `cgrca: failed to load scoring-config from ${path}: ${
          err instanceof Error ? err.message : String(err)
        }\n  → falling back to bundled defaults\n`,
      );
      break;
    }
  }
  return { config: DEFAULT_SCORING_CONFIG, source: "(bundled defaults)" };
}

/**
 * Shallow-deep merge of a partial config onto the defaults. Lets a user
 * specify only the knobs they want to override. Unspecified sections
 * inherit defaults verbatim.
 */
function mergeWithDefaults(partial: Partial<ScoringConfig>): ScoringConfig {
  return {
    matcher: { ...DEFAULT_SCORING_CONFIG.matcher, ...(partial.matcher ?? {}) },
    scorer: {
      calibrated_weights: {
        ...DEFAULT_SCORING_CONFIG.scorer.calibrated_weights,
        ...(partial.scorer?.calibrated_weights ?? {}),
      },
      legacy_weights: {
        ...DEFAULT_SCORING_CONFIG.scorer.legacy_weights,
        ...(partial.scorer?.legacy_weights ?? {}),
      },
    },
    augmenter: { ...DEFAULT_SCORING_CONFIG.augmenter, ...(partial.augmenter ?? {}) },
    retrieval: { ...DEFAULT_SCORING_CONFIG.retrieval, ...(partial.retrieval ?? {}) },
  };
}
