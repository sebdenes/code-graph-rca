import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { resolveScope } from "../graph/scope.js";
import { indexScope } from "../graph/orchestrator.js";
import {
  definitionOf,
  symbolsInFile,
  callersOf,
  calleesOf,
  recentlyChangedNear,
} from "../graph/queries.js";
import type {
  CallerTree,
  CalleeTree,
  CausalCandidate,
  Definition,
  RecentChange,
  SymbolKind,
} from "../types.js";
import { languageOf, walk } from "../graph/walker.js";
import { getScoringConfig } from "../config/scoring-config.js";
import { buildGraphContext } from "./context.js";
import { formatRcaPrompt } from "./prompt.js";
import {
  createRecencyHydrator,
  hydrateCallerTree,
  hydrateCalleeTree,
} from "./recency.js";
import { buildCausalChain } from "./causal.js";
import { tokenizeFailure, matchTokensAgainstKg, type TokenMatch } from "./textmode.js";
import type { Db } from "../graph/db.js";

export type FailureScope =
  | { kind: "stack-trace"; text: string }
  | { kind: "failing-test"; path: string; testName?: string }
  | { kind: "symbol"; name: string; file?: string }
  | { kind: "file"; path: string }
  // v0.5 Phase 1 free-text fallback (see textmode.ts).
  | { kind: "free-text"; text: string };

export interface RcaRequest {
  failureScope: FailureScope;
  repoRoot: string;
  budget?: { maxFiles?: number; maxLoc?: number; maxDepth?: number };
  /** Persist the indexed graph to this SQLite file path. Default: in-memory. */
  persist?: string;
  /** Override top-N candidates returned by the causal scorer. Default 5. */
  topN?: number;
  /** Use the pre-calibration hand-set weights for an A/B comparison.
   *  Default false (use the learned, calibrated weights). */
  useLegacyWeights?: boolean;
  /**
   * Output shape. `'prompt'` (default, backward-compat) populates
   * `RcaResult.prompt` with the full markdown RCA prompt. `'structured'`
   * skips prompt formatting entirely — `RcaResult.prompt` is set to `""`.
   * Consumers that build their own format (CLI ranked table, MCP grounding,
   * GitHub-App comments) should opt into `'structured'` and call
   * {@link formatRcaPrompt} themselves only if they need the markdown.
   */
  format?: "prompt" | "structured";
}

export interface RcaResult {
  graphContext: string;
  scope: { files: string[]; symbolCount: number; edgeCount: number };
  queries: Array<{ name: string; result: unknown }>;
  primarySymbol: string | null;
  /**
   * Full markdown RCA prompt. Populated when `RcaRequest.format === 'prompt'`
   * (the default, for backward-compat). Empty string when
   * `RcaRequest.format === 'structured'` — call {@link formatRcaPrompt} on
   * the structured fields if you want to render it lazily.
   */
  prompt: string;
  notes: string[];
  causalCandidates: CausalCandidate[];
  firstHypothesis: string | null;
}

export async function runRca(req: RcaRequest): Promise<RcaResult> {
  const notes: string[] = [];

  // v0.5 Phase 1 — free-text dispatch. Index the broad repo (capped by the
  // budget so we don't melt CI), tokenize the prose, hand the top-K
  // matches to the multi-anchor causal walker. We branch out before the
  // normal scope path because resolveScope can't pick seeds from prose.
  if (req.failureScope.kind === "free-text") {
    return runFreeTextRca(req, notes);
  }

  const scopeResult = resolveScope(req.failureScope, req.repoRoot, req.budget ?? {});
  notes.push(...scopeResult.notes);

  const queries: Array<{ name: string; result: unknown }> = [];
  let primarySymbol: string | null = scopeResult.primarySymbol;

  if (scopeResult.files.length === 0) {
    notes.push("no seed files resolved; skipping graph index and queries");
    const scope = { files: [] as string[], symbolCount: 0, edgeCount: 0 };
    const graphContext = buildGraphContext({ primarySymbol, scope, queries });
    const causalCandidates: CausalCandidate[] = [];
    const firstHypothesis: string | null = null;
    const prompt =
      (req.format ?? "prompt") === "structured"
        ? ""
        : formatRcaPrompt({
            failure: req.failureScope,
            scope,
            causalCandidates,
            firstHypothesis,
            queries,
            primarySymbol,
          });
    return {
      graphContext,
      scope,
      queries,
      primarySymbol,
      prompt,
      notes,
      causalCandidates,
      firstHypothesis,
    };
  }

  const indexed = await indexScope({
    repoRoot: req.repoRoot,
    scope: scopeResult.files,
    maxFiles: req.budget?.maxFiles ?? getScoringConfig().retrieval.default_max_files,
    ...(req.persist ? { persist: req.persist } : {}),
  });

  try {
    const seeds = scopeResult.seeds;
    const firstSeed = seeds[0];

    // Decide anchor symbol.
    let anchor: string | null = primarySymbol;
    if (!anchor && firstSeed) {
      const seedSymbols = symbolsInFile(indexed.db, firstSeed);
      const pick = seedSymbols.find(
        (s) => s.kind === "function" || s.kind === "class" || s.kind === "const",
      );
      if (pick) {
        anchor = pick.name;
        primarySymbol = anchor;
      } else {
        notes.push(`no function/class/const symbol found in seed file ${firstSeed}`);
      }
    }
    // Failing-test or other scopes whose seed file has no eligible symbol:
    // search the rest of the in-scope files, preferring non-test files.
    if (!anchor) {
      const candidates = scopeResult.files.filter((f) => f !== firstSeed);
      const ordered = [
        ...candidates.filter((f) => !/\.test\.|\.spec\./.test(f)),
        ...candidates.filter((f) => /\.test\.|\.spec\./.test(f)),
      ];
      for (const file of ordered) {
        const syms = symbolsInFile(indexed.db, file);
        const pick = syms.find(
          (s) => s.kind === "function" || s.kind === "class" || s.kind === "const",
        );
        if (pick) {
          anchor = pick.name;
          primarySymbol = anchor;
          notes.push(`anchor fallback: picked ${anchor} from ${file}`);
          break;
        }
      }
    }

    let callerTree: CallerTree | null = null;
    let calleeTree: CalleeTree | null = null;
    let anchorDefs: Definition[] = [];

    if (anchor) {
      anchorDefs = definitionOf(indexed.db, anchor);
      queries.push({ name: "definitionOf", result: anchorDefs });

      callerTree = callersOf(indexed.db, anchor, { depth: 2, minConfidence: 0.5 });
      queries.push({ name: "callersOf", result: callerTree });

      calleeTree = calleesOf(indexed.db, anchor, { depth: 1 });
      queries.push({ name: "calleesOf", result: calleeTree });

      if (firstSeed) {
        const seedSymbols = symbolsInFile(indexed.db, firstSeed);
        queries.push({ name: "symbolsInFile", result: seedSymbols });
      }

      const recent = recentlyChangedNear(indexed.db, anchor, {
        repoRoot: req.repoRoot,
        sinceDays: 90,
      });
      queries.push({ name: "recentlyChangedNear", result: recent });
    } else {
      notes.push("no anchor symbol; queries skipped");
    }

    // Hydrate recency on the trees if we have a real git repo.
    let anchorRecentChanges: RecentChange[] = [];
    if (callerTree && calleeTree && isGitRepo(req.repoRoot)) {
      const hydrator = createRecencyHydrator({ repoRoot: req.repoRoot });
      hydrateCallerTree(callerTree, indexed.db, hydrator);
      hydrateCalleeTree(calleeTree, indexed.db, hydrator);
      // The anchor isn't in either tree (the trees are caller/callee
      // neighborhoods of the anchor). Fetch its recency directly so the
      // most important node in the chain isn't excluded from the recency
      // signal.
      const firstDef = anchorDefs[0];
      if (firstDef) {
        anchorRecentChanges = hydrator.fetch(
          firstDef.file,
          firstDef.startLine,
          firstDef.endLine,
        );
      }
    }

    // Build the ranked causal-candidate shortlist.
    let causalCandidates: CausalCandidate[] = [];
    if (anchor && callerTree && calleeTree) {
      const firstDef = anchorDefs[0] ?? null;
      const anchorInput = {
        name: anchor,
        file: firstDef?.file ?? null,
        line: firstDef?.startLine ?? null,
        recentChanges: anchorRecentChanges,
      };
      try {
        causalCandidates = buildCausalChain(
          {
            anchor: anchorInput,
            callerTree,
            calleeTree,
            db: indexed.db,
          },
          {
            recencyDays: 90,
            topN: req.topN ?? 5,
            ...(req.useLegacyWeights ? { useLegacyWeights: true } : {}),
          },
        );
      } catch (err) {
        notes.push(
          `causal chain scorer failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // v0.5 Phase 1 — file: shape now seeds the chain with EVERY symbol in
    // the file, not the single first function/class/const that the anchor
    // picker happened to land on. The single-anchor path above still ran
    // (so primarySymbol stays populated for back-compat), but we replace
    // its candidates with the merged multi-anchor result so the table
    // surfaces every symbol in the file ranked by the existing 7 signals.
    if (req.failureScope.kind === "file" && firstSeed) {
      const fileSeeds = symbolsInFile(indexed.db, firstSeed)
        .filter(
          (s) =>
            s.kind === "function" ||
            s.kind === "method" ||
            s.kind === "class" ||
            s.kind === "const" ||
            s.kind === "interface" ||
            s.kind === "type" ||
            s.kind === "enum",
        )
        .map((s) => ({ name: s.name, file: firstSeed, line: s.startLine }));
      if (fileSeeds.length === 0) {
        notes.push(`no indexed symbols in ${firstSeed}`);
      } else {
        const merged = await runMultiAnchor({
          db: indexed.db,
          repoRoot: req.repoRoot,
          seeds: fileSeeds,
          topN: req.topN ?? 5,
          ...(req.useLegacyWeights ? { useLegacyWeights: true } : {}),
        });
        causalCandidates = merged.candidates;
        // Promote the highest-scoring seed to primarySymbol so the table
        // header / `primarySymbol` field reflects what actually drove the
        // ranking. Falls back to the original anchor if every seed scored 0.
        if (merged.topAnchorName) primarySymbol = merged.topAnchorName;
      }
    }

    const firstHypothesis = computeFirstHypothesis(causalCandidates);

    const scope = {
      files: scopeResult.files,
      symbolCount: indexed.symbolCount,
      edgeCount: indexed.edgeCount,
    };
    const graphContext = buildGraphContext({ primarySymbol, scope, queries });
    const prompt =
      (req.format ?? "prompt") === "structured"
        ? ""
        : formatRcaPrompt({
            failure: req.failureScope,
            scope,
            causalCandidates,
            firstHypothesis,
            queries,
            primarySymbol,
          });

    return {
      graphContext,
      scope,
      queries,
      primarySymbol,
      prompt,
      notes,
      causalCandidates,
      firstHypothesis,
    };
  } finally {
    indexed.db.close();
  }
}

/**
 * Detect whether `repoRoot` is inside a git working tree. Walks parents up
 * to 12 levels looking for a `.git` entry — the previous version only
 * checked `repoRoot/.git`, which silently disabled recency hydration when
 * `--repo` pointed at a monorepo subdir like `packages/core` whose `.git`
 * lives at the parent root.
 *
 * Returns `false` for non-repos, deleted repos, and unreadable paths. Never
 * throws: a transient FS error here would otherwise sink the whole RCA run,
 * but recency is best-effort by design.
 */
function isGitRepo(repoRoot: string): boolean {
  try {
    let dir = repoRoot;
    for (let i = 0; i < 12; i++) {
      if (existsSync(join(dir, ".git"))) return true;
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
    return false;
  } catch {
    return false;
  }
}

function computeFirstHypothesis(
  candidates: CausalCandidate[],
): string | null {
  if (candidates.length === 0) return null;
  const top = candidates[0];
  if (!top) return null;
  const loc =
    top.file !== null
      ? top.line !== null
        ? `${top.file}:${top.line}`
        : top.file
      : "unknown location";
  return `The root cause is most likely in ${top.name} (${loc}) — ${top.rationale}`;
}

// ---------------------------------------------------------------------------
// v0.5 Phase 1 — multi-anchor helpers
// ---------------------------------------------------------------------------

interface MultiAnchorSeed {
  name: string;
  file: string | null;
  line: number | null;
}

interface MultiAnchorOptions {
  db: Db;
  repoRoot: string;
  seeds: MultiAnchorSeed[];
  topN: number;
  useLegacyWeights?: boolean;
}

interface MultiAnchorResult {
  candidates: CausalCandidate[];
  /** Name of the highest-scoring seed (first to surface in the merged list). */
  topAnchorName: string | null;
}

/**
 * Run `buildCausalChain` once per anchor seed and merge the results,
 * keeping the MAX score per (file, name) key. The MAX rule (vs SUM) means
 * the same symbol surfacing as a strong callee for two seeds doesn't
 * "double up" — each seed represents a hypothesis, not a vote.
 *
 * Recency hydration runs once per seed (each call to buildCausalChain
 * needs hydrated trees). For large file: anchors this is N git-blame
 * shell-outs; the recency hydrator caches per (file, line-range) so the
 * cost is amortized across overlapping neighborhoods.
 *
 * Returns the topN merged candidates. `topAnchorName` is the seed that
 * produced the highest-scoring final candidate so the runner can update
 * `primarySymbol` to something the user will recognize.
 */
async function runMultiAnchor(
  opts: MultiAnchorOptions,
): Promise<MultiAnchorResult> {
  const merged = new Map<string, CausalCandidate>();
  // Track which seed produced the merged top entry — used to update
  // primarySymbol in the runner.
  let topScore = -Infinity;
  let topSeedName: string | null = null;
  const isGit = isGitRepo(opts.repoRoot);
  // One hydrator across all seeds so the per (file,line-range) cache is
  // shared — overlapping caller/callee neighborhoods are common across
  // seeds in the same file.
  const hydrator = isGit
    ? createRecencyHydrator({ repoRoot: opts.repoRoot })
    : null;

  for (const seed of opts.seeds) {
    let callerTree: CallerTree;
    let calleeTree: CalleeTree;
    try {
      callerTree = callersOf(opts.db, seed.name, {
        depth: 2,
        minConfidence: 0.5,
      });
      calleeTree = calleesOf(opts.db, seed.name, { depth: 1 });
    } catch {
      continue;
    }

    let anchorRecentChanges: RecentChange[] = [];
    if (hydrator) {
      try {
        hydrateCallerTree(callerTree, opts.db, hydrator);
        hydrateCalleeTree(calleeTree, opts.db, hydrator);
        const defs = definitionOf(opts.db, seed.name);
        const firstDef = defs[0];
        if (firstDef) {
          anchorRecentChanges = hydrator.fetch(
            firstDef.file,
            firstDef.startLine,
            firstDef.endLine,
          );
        }
      } catch {
        // Recency is best-effort — keep going if a single seed's blame
        // shells fail.
      }
    }

    let perSeed: CausalCandidate[] = [];
    try {
      perSeed = buildCausalChain(
        {
          anchor: {
            name: seed.name,
            file: seed.file,
            line: seed.line,
            recentChanges: anchorRecentChanges,
          },
          callerTree,
          calleeTree,
          db: opts.db,
        },
        {
          recencyDays: 90,
          // Pull more per-seed than the final topN so the merge has
          // enough material to pick the best across seeds.
          topN: Math.max(opts.topN * 2, 10),
          ...(opts.useLegacyWeights ? { useLegacyWeights: true } : {}),
        },
      );
    } catch {
      continue;
    }

    for (const cand of perSeed) {
      const key = `${cand.file ?? "?"}:${cand.name}`;
      const existing = merged.get(key);
      if (!existing || cand.score > existing.score) {
        merged.set(key, cand);
      }
      if (cand.score > topScore) {
        topScore = cand.score;
        topSeedName = seed.name;
      }
    }
  }

  const sorted = [...merged.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const af = a.file ?? "";
    const bf = b.file ?? "";
    if (af !== bf) return af < bf ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return {
    candidates: sorted.slice(0, opts.topN),
    topAnchorName: topSeedName,
  };
}

// ---------------------------------------------------------------------------
// v0.5 Phase 1 — free-text RCA path
// ---------------------------------------------------------------------------

/**
 * Free-text dispatch: index a broad slice of the repo (capped by the
 * budget), tokenize the failure, hand the top-K token matches to the
 * multi-anchor walker.
 *
 * We index broadly here because resolveScope's free-text branch returned
 * no seeds — it can't, since prose doesn't pin to a specific file. The
 * scope budget caps how much we crawl: default 200 files.
 *
 * Behaves like the single-anchor path for the rest of the contract:
 * builds graphContext, formats prompt (when requested), populates
 * primarySymbol from the highest-scoring token-match seed.
 */
async function runFreeTextRca(
  req: RcaRequest,
  notes: string[],
): Promise<RcaResult> {
  if (req.failureScope.kind !== "free-text") {
    throw new Error("runFreeTextRca called with non-free-text scope");
  }
  const queries: Array<{ name: string; result: unknown }> = [];
  let primarySymbol: string | null = null;

  const tokens = tokenizeFailure(req.failureScope.text);
  if (
    tokens.identifierTokens.length === 0 &&
    tokens.literalTokens.length === 0
  ) {
    notes.push("free-text: no tokens extracted from input");
    return emptyFreeTextResult(req, notes, queries, primarySymbol);
  }

  // Discover parseable files at the repo root, capped by the budget. We
  // don't reuse resolveScope for this — that walker is import-graph
  // expansion from a known seed, which we don't have. We just want a
  // shallow file list to feed indexScope.
  const maxFiles = req.budget?.maxFiles ?? getScoringConfig().retrieval.default_max_files;
  const broadFiles = collectBroadScope(req.repoRoot, maxFiles);
  if (broadFiles.length === 0) {
    notes.push("free-text: no parseable files in repo root");
    return emptyFreeTextResult(req, notes, queries, primarySymbol);
  }

  const indexed = await indexScope({
    repoRoot: req.repoRoot,
    scope: broadFiles,
    maxFiles,
    ...(req.persist ? { persist: req.persist } : {}),
  });

  try {
    const matches = matchTokensAgainstKg(indexed.db, tokens);
    if (matches.length === 0) {
      notes.push("free-text: no token matches in indexed scope");
      return finalizeResult(req, notes, queries, primarySymbol, [], {
        files: broadFiles,
        symbolCount: indexed.symbolCount,
        edgeCount: indexed.edgeCount,
      });
    }
    queries.push({
      name: "tokenMatches",
      result: matches.slice(0, 16),
    });

    // v0.7: seed cap, default top-N, and matcher-tail augmenter sourced
    // from scoring-config.json. The autoresearch loop tunes these.
    const _retrievalCfg = getScoringConfig().retrieval;
    const _augmenterCfg = getScoringConfig().augmenter;

    // Top-K token matches → anchor seeds for the chain walker.
    const seeds: MultiAnchorSeed[] = matches.slice(0, _retrievalCfg.free_text_seed_cap).map((m) => ({
      name: m.symbolName,
      file: m.file,
      line: m.line,
    }));
    primarySymbol = seeds[0]?.name ?? null;

    const merged = await runMultiAnchor({
      db: indexed.db,
      repoRoot: req.repoRoot,
      seeds,
      topN: req.topN ?? _retrievalCfg.default_top_n,
      ...(req.useLegacyWeights ? { useLegacyWeights: true } : {}),
    });
    if (merged.topAnchorName) primarySymbol = merged.topAnchorName;

    // Augment with matcher's substring-only candidates that didn't survive
    // the multi-anchor walk. Cap is `topN * multiplier` floored at the
    // configured floor — ensures wider menus on small-topN configs.
    const targetN = req.topN ?? _retrievalCfg.default_top_n;
    const augmentedTopN = Math.max(
      targetN * _augmenterCfg.matcher_tail_topn_multiplier,
      _augmenterCfg.matcher_tail_floor,
    );
    const augmented = augmentWithMatcherTail(
      indexed.db,
      merged.candidates,
      matches,
      augmentedTopN,
    );

    return finalizeResult(req, notes, queries, primarySymbol, augmented, {
      files: broadFiles,
      symbolCount: indexed.symbolCount,
      edgeCount: indexed.edgeCount,
    });
  } finally {
    indexed.db.close();
  }
}

/**
 * Append matcher candidates that DIDN'T appear in the multi-anchor merged
 * output. Lifts the substring-only matches that lose to exact-match seed
 * domination during the graph walk. Returns at most `cap` total entries.
 *
 * Score for appended entries uses the matcher's totalScore, scaled into
 * the bottom of the existing range so they rank below walked candidates
 * but above untouched symbols. This mirrors how `--llm` re-ranking can
 * later promote them on the basis of body-content fit.
 */
function augmentWithMatcherTail(
  db: Db,
  walked: CausalCandidate[],
  matches: TokenMatch[],
  cap: number,
): CausalCandidate[] {
  if (walked.length >= cap || matches.length === 0) return walked.slice(0, cap);
  // Track existing (file, name) so we don't duplicate.
  const seen = new Set<string>();
  for (const c of walked) seen.add(`${c.file ?? ""}|${c.name}`);

  const lowestScore = walked.length > 0 ? walked[walked.length - 1]!.score : 0.5;
  const out: CausalCandidate[] = [...walked];
  for (const m of matches) {
    if (out.length >= cap) break;
    const key = `${m.file ?? ""}|${m.symbolName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Hydrate kind/loc/subsystem from the indexed DB if available.
    let kind: SymbolKind | null = null;
    let loc: number | null = null;
    let subsystem: string | null = null;
    try {
      const row = db
        .prepare(
          "SELECT s.kind AS kind, s.end_line - s.start_line + 1 AS loc, f.subsystem AS subsystem FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?",
        )
        .get(m.symbolId) as { kind: string; loc: number; subsystem: string | null } | undefined;
      if (row) {
        kind = row.kind as SymbolKind;
        loc = row.loc;
        subsystem = row.subsystem;
      }
    } catch {
      // best-effort; leave nulls
    }
    out.push({
      name: m.symbolName,
      file: m.file,
      line: m.line,
      kind,
      loc,
      subsystem,
      role: "anchor",
      distance: 0,
      // Score below the lowest walked candidate but above 0; preserves
      // matcher's relative ranking among the appended tail.
      score: Math.min(lowestScore - 0.01, m.totalScore * 0.5),
      signals: {
        recencyScore: 0,
        proximityScore: 0,
        ambiguityScore: 0,
        coChangeScore: 0,
        subsystemScore: 0,
        complexityScore: 0,
        dataflowScore: 0,
      },
      rationale: `Matcher tail: surfaced by free-text token search (matcher score ${m.totalScore.toFixed(2)}); didn't survive seed-driven graph walk.`,
      recentChanges: [],
      unresolvedCallTargets: [],
    });
  }
  return out;
}

/**
 * Walk `repoRoot` with the same ignore set scope.ts uses, returning up to
 * `maxFiles` parseable files. This is intentionally shallower than
 * scope.ts's `scanRepo` (no package detection, no Python-package
 * inference) because free-text only needs files to feed indexScope.
 */
function collectBroadScope(repoRoot: string, maxFiles: number): string[] {
  // Reuse walker — it loads .gitignore and the IGNORE_DIRS set, and guards
  // against symlink loops. The bespoke walker that lived here previously
  // skipped only a hardcoded dot-dir set, which let `.claude/`, `.agent/`,
  // and `.ruff_cache/` exhaust the maxFiles budget before reaching real
  // source. That was the silent reason free-text RCA returned 0 candidates
  // on real bugs in v0.5 Phase 1's eval (2026-05-02).
  try {
    if (!statSync(repoRoot).isDirectory()) return [];
  } catch {
    return [];
  }
  // Walk uncapped (gitignore keeps it bounded) and trim *after* filtering
  // to parseable, so maxFiles refers to indexable Python/TS source — not
  // a quota that .md/.json/.txt files can eat into.
  return walk(repoRoot)
    .filter((f) => f.language === "typescript" || f.language === "python")
    .slice(0, maxFiles)
    .map((f) => f.relPath);
}

function emptyFreeTextResult(
  req: RcaRequest,
  notes: string[],
  queries: Array<{ name: string; result: unknown }>,
  primarySymbol: string | null,
): RcaResult {
  return finalizeResult(req, notes, queries, primarySymbol, [], {
    files: [],
    symbolCount: 0,
    edgeCount: 0,
  });
}

function finalizeResult(
  req: RcaRequest,
  notes: string[],
  queries: Array<{ name: string; result: unknown }>,
  primarySymbol: string | null,
  causalCandidates: CausalCandidate[],
  scope: { files: string[]; symbolCount: number; edgeCount: number },
): RcaResult {
  const firstHypothesis = computeFirstHypothesis(causalCandidates);
  const graphContext = buildGraphContext({ primarySymbol, scope, queries });
  const prompt =
    (req.format ?? "prompt") === "structured"
      ? ""
      : formatRcaPrompt({
          failure: req.failureScope,
          scope,
          causalCandidates,
          firstHypothesis,
          queries,
          primarySymbol,
        });
  return {
    graphContext,
    scope,
    queries,
    primarySymbol,
    prompt,
    notes,
    causalCandidates,
    firstHypothesis,
  };
}
