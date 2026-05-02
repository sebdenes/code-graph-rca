import type { Db } from "../graph/db.js";
import { pathBetween } from "../graph/queries.js";
import type {
  CallerNode,
  CallerTree,
  CalleeNode,
  CalleeTree,
  CausalCandidate,
  RecentChange,
  SymbolKind,
} from "../types.js";
import { isStdlibName } from "./stdlib-names.js";

/**
 * Causal chain ranker. Pure function (modulo a single Db read for unresolved-edge counts)
 * that takes a hydrated caller/callee neighborhood and returns a ranked shortlist of
 * `CausalCandidate`s — the LLM's "where the bug most likely is" cheat sheet.
 *
 * Scoring is deterministic. See the rubric below; weights are inlined and commented.
 *
 * --- weight calibration -------------------------------------------------
 * The per-signal multipliers below were fit from 101 labelled
 * (failure -> known fix location) pairs mined from sebdenes/code-graph-rca
 * and sebdenes/athlai. The fit code lives at
 *   tools/calibration/fit.mjs
 * and the corpus (gitignored, regenerate via collect.mjs) at
 *   tools/calibration/corpus.jsonl
 *
 * Eval date: 2026-05-02 (v2 — refit including dataflowScore as a 7th
 * feature; v1 was 2026-05-02 morning, six features only). Pass
 * `useLegacyWeights: true` to recover the pre-calibration hand-set bucket
 * constants for an A/B comparison.
 * --------------------------------------------------------------------- */

export interface CausalChainOptions {
  /** Window for "recent" — anything older contributes 0 to recencyScore. Default 90. */
  recencyDays?: number;
  /** Top-N candidates returned. Default 5. */
  topN?: number;
  /** Optional callee tree (for ambiguity detection — unresolved outgoing edges score). */
  calleeTreeSource?: CalleeTree;
  /** Use the pre-calibration hand-set bucket constants instead of the learned
   *  per-signal multipliers. Default false. */
  useLegacyWeights?: boolean;
}

export interface CausalChainInput {
  /** Where the failure surfaced. */
  anchor: {
    name: string;
    file: string | null;
    line: number | null;
    /** Optional anchor subsystem; if omitted, looked up from Db. */
    subsystem?: string | null;
    /** Recent commits touching the anchor's lines. Populate from the
     *  recency hydrator; falls back to empty if not provided. */
    recentChanges?: RecentChange[];
  };
  /** Caller tree, hydrated with recentChanges. */
  callerTree: CallerTree;
  /** Callee tree, hydrated with recentChanges. */
  calleeTree: CalleeTree;
  /** Db for ambiguity lookup (unresolved outgoing edges per symbol). */
  db: Db;
}

interface RawCandidate {
  key: string;
  name: string;
  file: string | null;
  line: number | null;
  role: "anchor" | "caller" | "callee";
  distance: number;
  recentChanges: RecentChange[];
  /** Subsystem inferred via Db lookup (best effort, may be null). */
  subsystem: string | null;
}

// Bucket shapes (kept for explainability — same buckets as v0.x).
const RECENCY_BUCKET_7 = 3;
const RECENCY_BUCKET_30 = 2;
const RECENCY_BUCKET_90 = 1;

const PROXIMITY_ANCHOR = 2.5;
const PROXIMITY_DIRECT = 1;
const PROXIMITY_TWO_HOP = 0.5;

const AMBIGUITY_ONE = 0.5;
const AMBIGUITY_2_3 = 1;
const AMBIGUITY_4_PLUS = 1.5;

const COCHANGE_PER_CLUSTER = 2;
const COCHANGE_CAP = 3;

const SUBSYSTEM_MATCH = 0.5;

const COMPLEXITY_MAX = 1.5;

// Data-flow distance signal. pathBetween over CALLS + arg-binding edges; the
// shortest hop count from candidate → anchor is decayed linearly. dist=1
// (direct flow) yields 1.5, dist=4 yields 0.3, no path within DATAFLOW_MAX_HOPS
// yields 0. Capped at the same magnitude as the complexity bonus so a single
// data-flow hop can plausibly outweigh proximity+ambiguity, but cannot
// monopolise the score.
const DATAFLOW_MAX = 1.5;
const DATAFLOW_DECAY_PER_HOP = 0.4;
const DATAFLOW_MAX_HOPS = 4;

const DEFAULT_RECENCY_DAYS = 90;
const DEFAULT_TOP_N = 5;

// Per-signal multipliers learned from the calibration corpus
// (tools/calibration/fit.mjs, eval 2026-05-02 v2 — 7-feature refit).
// Each is applied to the bucket-derived raw signal score before summation.
//
// Fit on 101 unanchored entries (cgrca_input_caller / cgrca_input_trace,
// i.e. the realistic case where the failure-input doesn't already name
// the fix symbol). 80/20 train/holdout, seed=42, 2000 iters of batch
// gradient descent on a logistic regression with binary "is gold candidate"
// as the label, anchor candidates filtered out (since the anchor is never
// the gold by construction). Negative raw weights are clipped to 0 so
// every signal can only *help* a candidate's score (preserves the
// rationale text's "dominant signal" semantics).
//
// Holdout (n=21, 2026-05-02 v3 fit): top-1 0.333 -> 0.429 (clipped),
// top-5 0.905 -> 0.810, MRR 0.574 -> 0.585 vs the legacy hand-set weights.
// The big jump from v2's holdout (top-1 0.20) is mostly because the corpus
// itself is richer now: weeks-5/6 local-variable extraction grew the
// arg_bindings.source_symbol_id resolution rate from 22.8% to 81.66%
// (cgrca) / 77.6% (athlai), so pathBetween + ambiguity counts have more
// signal to work with.
//
// Note on dataflowScore: raw weight = -0.80 (clipped to 0). At the
// per-candidate level it still doesn't discriminate gold from non-gold
// (per-candidate r ≈ -0.06 even after the resolution-rate jump). The
// extra paths the local extraction surfaces benefit gold and bystanders
// alike. The infrastructure ships and the rationale text still fires
// when the signal is dominant — but until the dataflow extractor
// distinguishes "this candidate is the real value provenance" from
// "this candidate sits on a graph edge to the anchor", the calibrated
// path runs with W_DATAFLOW=0.
const W_RECENCY = 0.0766;
const W_PROXIMITY = 0.0; // raw fit -1.39, clipped — proximity is nearly
                          // constant within a non-anchor candidate set, so
                          // it carries no discriminative signal here.
const W_AMBIGUITY = 0.2133;
const W_COCHANGE = 0.4744;
const W_SUBSYSTEM = 0.8909;
const W_COMPLEXITY = 0.1679;
const W_DATAFLOW = 0.0; // raw fit -0.80, clipped — see note above.

// Legacy (pre-calibration) multipliers — all 1.0, i.e. raw bucket scores.
// Data-flow stays at 1.0 here so the legacy A/B path keeps the new signal
// fully active (the legacy track is the "everything counts equally" floor).
const LEGACY_W = {
  recency: 1.0,
  proximity: 1.0,
  ambiguity: 1.0,
  coChange: 1.0,
  subsystem: 1.0,
  complexity: 1.0,
  dataflow: 1.0,
};
const CALIBRATED_W = {
  recency: W_RECENCY,
  proximity: W_PROXIMITY,
  ambiguity: W_AMBIGUITY,
  coChange: W_COCHANGE,
  subsystem: W_SUBSYSTEM,
  complexity: W_COMPLEXITY,
  dataflow: W_DATAFLOW,
};

export function buildCausalChain(
  input: CausalChainInput,
  opts: CausalChainOptions = {},
): CausalCandidate[] {
  const recencyDays = opts.recencyDays ?? DEFAULT_RECENCY_DAYS;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const W = opts.useLegacyWeights ? LEGACY_W : CALIBRATED_W;

  // 1. Collect candidates: anchor + callers (depth<=2) + callees (depth<=2), deduped.
  const candidates = collectCandidates(input);

  // 2. Per-candidate ambiguity, kind, loc, subsystem lookup (single-shot per candidate).
  const ambiguityByKey = new Map<string, string[]>();
  const subsystemByKey = new Map<string, string | null>();
  const kindByKey = new Map<string, SymbolKind | null>();
  const locByKey = new Map<string, number | null>();
  for (const c of candidates) {
    const lookup = lookupSymbolMeta(input.db, c.name, c.file);
    ambiguityByKey.set(c.key, lookup.unresolvedTargets);
    if (c.subsystem === null) subsystemByKey.set(c.key, lookup.subsystem);
    else subsystemByKey.set(c.key, c.subsystem);
    kindByKey.set(c.key, lookup.kind);
    locByKey.set(c.key, lookup.loc);
  }

  // 3. Co-change clusters: shas appearing on >=2 candidates within recencyDays.
  const coChangeBonus = computeCoChange(candidates, recencyDays);

  // Anchor subsystem: use input if provided, otherwise fall back to the Db lookup
  // we already performed for the anchor candidate.
  const anchorCandidate = candidates.find((c) => c.role === "anchor");
  const anchorSubsystem =
    input.anchor.subsystem !== undefined && input.anchor.subsystem !== null
      ? input.anchor.subsystem
      : anchorCandidate
        ? subsystemByKey.get(anchorCandidate.key) ?? null
        : null;

  // 4. Score each candidate.
  const scored: CausalCandidate[] = candidates.map((c) => {
    const recencyScore = computeRecencyScore(c.recentChanges, recencyDays);
    const proximityScore = computeProximityScore(c.distance);
    const unresolved = ambiguityByKey.get(c.key) ?? [];
    const ambiguityScore = computeAmbiguityScore(unresolved.length);
    const coChangeScore = coChangeBonus.get(c.key) ?? 0;
    const candidateSubsystem = subsystemByKey.get(c.key) ?? null;
    const subsystemScore =
      anchorSubsystem !== null &&
      candidateSubsystem !== null &&
      candidateSubsystem === anchorSubsystem
        ? SUBSYSTEM_MATCH
        : 0;

    const loc = locByKey.get(c.key) ?? 0;
    const complexityScore =
      loc && loc > 0
        ? Math.min(Math.log2(loc / 20 + 1) * 0.6, COMPLEXITY_MAX)
        : 0;

    // Data-flow distance: shortest pathBetween hop-count from this candidate
    // back to the anchor over CALLS + arg-binding flow edges. The anchor
    // itself trivially has dist=1 (single-step seed path); we map that to 0
    // so the anchor doesn't get a free 1.5 boost from the new signal — the
    // anchor already gets PROXIMITY_ANCHOR.
    const dataflowScore = c.role === "anchor"
      ? 0
      : computeDataflowScore(input.db, c.name, input.anchor.name);

    // Calibrated weighted sum (per-signal multipliers from logistic
    // regression fit; see weight block at top of file). Data-flow's weight
    // stays at 1.0 in both blocks until week-5 re-calibrates.
    const score =
      W.recency * recencyScore +
      W.proximity * proximityScore +
      W.ambiguity * ambiguityScore +
      W.coChange * coChangeScore +
      W.subsystem * subsystemScore +
      W.complexity * complexityScore +
      W.dataflow * dataflowScore;

    const signals = {
      recencyScore,
      proximityScore,
      ambiguityScore,
      coChangeScore,
      subsystemScore,
      complexityScore,
      dataflowScore,
    };

    const rationale = buildRationale(c, signals, unresolved);

    return {
      name: c.name,
      file: c.file,
      line: c.line,
      kind: kindByKey.get(c.key) ?? null,
      loc: locByKey.get(c.key) ?? null,
      subsystem: candidateSubsystem,
      role: c.role,
      distance: c.distance,
      score,
      signals,
      rationale,
      recentChanges: c.recentChanges,
      unresolvedCallTargets: unresolved,
    };
  });

  // 5. Sort: score DESC, recency (newer = smaller daysAgo) ASC, file ASC.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aDays = mostRecentDaysAgo(a.recentChanges);
    const bDays = mostRecentDaysAgo(b.recentChanges);
    if (aDays !== bDays) return aDays - bDays;
    const aFile = a.file ?? "";
    const bFile = b.file ?? "";
    if (aFile < bFile) return -1;
    if (aFile > bFile) return 1;
    return 0;
  });

  return scored.slice(0, topN);
}

// ---------- candidate collection ----------

function collectCandidates(input: CausalChainInput): RawCandidate[] {
  const map = new Map<string, RawCandidate>();
  const keyOf = (file: string | null, name: string): string =>
    `${file ?? "?"}:${name}`;

  // Anchor first — distance 0.
  const anchorKey = keyOf(input.anchor.file, input.anchor.name);
  map.set(anchorKey, {
    key: anchorKey,
    name: input.anchor.name,
    file: input.anchor.file,
    line: input.anchor.line,
    role: "anchor",
    distance: 0,
    recentChanges: input.anchor.recentChanges ?? [],
    subsystem: input.anchor.subsystem ?? null,
  });

  // Callers, walked to depth 2.
  walkCallers(input.callerTree.callers, 1, map, keyOf);

  // Callees, walked to depth 2.
  walkCallees(input.calleeTree.callees, 1, map, keyOf);

  return [...map.values()];
}

function walkCallers(
  nodes: CallerNode[],
  distance: number,
  map: Map<string, RawCandidate>,
  keyOf: (file: string | null, name: string) => string,
): void {
  if (distance > 2) return;
  for (const n of nodes) {
    const key = keyOf(n.file, n.name);
    const existing = map.get(key);
    if (!existing || existing.distance > distance) {
      // Don't overwrite the anchor.
      if (!existing || existing.role !== "anchor") {
        map.set(key, {
          key,
          name: n.name,
          file: n.file,
          line: n.line,
          role: "caller",
          distance,
          recentChanges: n.recentChanges ?? [],
          subsystem: null,
        });
      }
    }
    walkCallers(n.callers, distance + 1, map, keyOf);
  }
}

function walkCallees(
  nodes: CalleeNode[],
  distance: number,
  map: Map<string, RawCandidate>,
  keyOf: (file: string | null, name: string) => string,
): void {
  if (distance > 2) return;
  for (const n of nodes) {
    const key = keyOf(n.file, n.name);
    const existing = map.get(key);
    if (!existing || existing.distance > distance) {
      if (!existing || existing.role !== "anchor") {
        map.set(key, {
          key,
          name: n.name,
          file: n.file,
          line: n.line,
          role: "callee",
          distance,
          recentChanges: n.recentChanges ?? [],
          subsystem: null,
        });
      }
    }
    walkCallees(n.callees, distance + 1, map, keyOf);
  }
}

// ---------- scoring helpers ----------

function computeRecencyScore(
  changes: RecentChange[],
  recencyDays: number,
): number {
  if (changes.length === 0) return 0;
  const newest = changes[0];
  if (!newest) return 0;
  const days = newest.daysAgo;
  if (days > recencyDays) return 0;
  if (days <= 7) return RECENCY_BUCKET_7;
  if (days <= 30) return RECENCY_BUCKET_30;
  if (days <= 90) return RECENCY_BUCKET_90;
  return 0;
}

function computeProximityScore(distance: number): number {
  if (distance === 0) return PROXIMITY_ANCHOR;
  if (distance === 1) return PROXIMITY_DIRECT;
  if (distance === 2) return PROXIMITY_TWO_HOP;
  return 0;
}

function computeAmbiguityScore(unresolvedCount: number): number {
  if (unresolvedCount <= 0) return 0;
  if (unresolvedCount === 1) return AMBIGUITY_ONE;
  if (unresolvedCount <= 3) return AMBIGUITY_2_3;
  return AMBIGUITY_4_PLUS;
}

/**
 * Compute the data-flow score for `name` against `anchorName` using
 * pathBetween over CALLS + arg-binding edges. The hop-count `dist` returned
 * by pathBetween includes the seed node, so dist=1 means same-symbol (no
 * edges traversed); dist=2 means one edge. We map "edges crossed" =
 * `dist - 1` to a linear decay: 1 edge → 1.5, 2 edges → 1.1, 3 edges → 0.7,
 * 4 edges → 0.3, deeper or no path → 0.
 *
 * Wrapped in try/catch because pathBetween hits sqlite — a corrupt or
 * concurrently-modified Db should never sink the whole scorer.
 */
function computeDataflowScore(
  db: Db,
  name: string,
  anchorName: string,
): number {
  if (name === anchorName) return 0;
  let stepCount = Infinity;
  try {
    const path = pathBetween(db, name, anchorName, {
      maxDepth: DATAFLOW_MAX_HOPS,
    });
    if (path && path.length > 0) stepCount = path.length;
  } catch {
    return 0;
  }
  if (stepCount === Infinity) return 0;
  const edges = stepCount - 1;
  if (edges <= 0 || edges > DATAFLOW_MAX_HOPS) return 0;
  return Math.max(0, DATAFLOW_MAX - DATAFLOW_DECAY_PER_HOP * (edges - 1));
}

function computeCoChange(
  candidates: RawCandidate[],
  recencyDays: number,
): Map<string, number> {
  // Group candidates by sha (within recencyDays). A sha shared by >=2 candidates → cluster.
  const shaToKeys = new Map<string, Set<string>>();
  const candidatesByKey = new Map<string, RawCandidate>();
  for (const c of candidates) {
    candidatesByKey.set(c.key, c);
    for (const ch of c.recentChanges) {
      if (ch.daysAgo > recencyDays) continue;
      let set = shaToKeys.get(ch.commit);
      if (!set) {
        set = new Set<string>();
        shaToKeys.set(ch.commit, set);
      }
      set.add(c.key);
    }
  }

  const bonus = new Map<string, number>();
  for (const [, keys] of shaToKeys) {
    if (keys.size < 2) continue;
    // Gate: only cluster if anchor is one of the keys OR cluster size >= 3.
    const hasAnchor = [...keys].some(
      (k) => candidatesByKey.get(k)?.role === "anchor",
    );
    if (!hasAnchor && keys.size < 3) continue;
    // Demote co-change in megacommits: a sha touching N candidates contributes
    // COCHANGE_PER_CLUSTER / log2(N+1) per candidate, not the full per-cluster
    // amount. A 2-candidate cluster still gets ~+1.26; a 12-candidate megacommit
    // contributes ~+0.55 each.
    const perCluster = COCHANGE_PER_CLUSTER / Math.log2(keys.size + 1);
    for (const key of keys) {
      const existing = bonus.get(key) ?? 0;
      const next = Math.min(existing + perCluster, COCHANGE_CAP);
      bonus.set(key, next);
    }
  }
  return bonus;
}

function mostRecentDaysAgo(changes: RecentChange[]): number {
  if (changes.length === 0) return Number.POSITIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  for (const ch of changes) {
    if (ch.daysAgo < min) min = ch.daysAgo;
  }
  return min;
}

// ---------- rationale ----------

function buildRationale(
  c: RawCandidate,
  signals: {
    recencyScore: number;
    proximityScore: number;
    ambiguityScore: number;
    coChangeScore: number;
    subsystemScore: number;
    complexityScore: number;
    dataflowScore: number;
  },
  unresolved: string[],
): string {
  // Pick the dominant signal (highest contribution; ties broken by a fixed
  // order). Data-flow is checked before co-change because a direct data-flow
  // hop is more concrete causal evidence ("X reaches the anchor in 2 frames")
  // than a shared sha.
  const entries: Array<[string, number]> = [
    ["dataflow", signals.dataflowScore],
    ["coChange", signals.coChangeScore],
    ["recency", signals.recencyScore],
    ["ambiguity", signals.ambiguityScore],
    ["proximity", signals.proximityScore],
    ["subsystem", signals.subsystemScore],
  ];
  let dominantKey = "proximity";
  let dominantValue = -Infinity;
  for (const [k, v] of entries) {
    if (v > dominantValue) {
      dominantValue = v;
      dominantKey = k;
    }
  }

  const newest = c.recentChanges[0];

  if (dominantKey === "dataflow" && signals.dataflowScore > 0) {
    // Invert the decay to recover the hop count for the prose. We round
    // because floating-point noise in the score should never produce a
    // fractional hop count to the user.
    const hops = Math.max(
      1,
      Math.round((DATAFLOW_MAX - signals.dataflowScore) / DATAFLOW_DECAY_PER_HOP) + 1,
    );
    return `${c.name} reaches the anchor via ${hops} data-flow hop${hops === 1 ? "" : "s"} (CALLS + arg-binding edges) — the value that surfaces at the failure originates here.`;
  }
  if (dominantKey === "coChange" && signals.coChangeScore > 0 && newest) {
    return `Co-changed with the anchor in commit ${shortSha(newest.commit)} — the change set that introduced the failure neighborhood.`;
  }
  if (dominantKey === "recency" && newest) {
    return `Modified ${newest.daysAgo} day${newest.daysAgo === 1 ? "" : "s"} ago in commit ${shortSha(newest.commit)} — most recent change in the failure neighborhood.`;
  }
  if (dominantKey === "ambiguity" && unresolved.length > 0) {
    const role = c.role === "anchor" ? "Anchor" : c.role === "caller" ? "Caller of the anchor" : "Callee of the anchor";
    return `${role} with ${unresolved.length} unresolved outgoing call${unresolved.length === 1 ? "" : "s"} — a likely site for dynamic dispatch surprises.`;
  }
  if (c.role === "anchor") {
    return `The anchor itself; no dominant external signal but it is the origin of the failure neighborhood.`;
  }
  if (c.role === "caller") {
    return `Direct caller of the anchor; no recent changes but stays on the shortlist due to topology.`;
  }
  return `Direct callee of the anchor; no recent changes but stays on the shortlist due to topology.`;
}

function shortSha(sha: string): string {
  return sha.length >= 7 ? sha.slice(0, 7) : sha;
}

// ---------- Db lookup for ambiguity & subsystem ----------

interface SymbolMeta {
  unresolvedTargets: string[];
  subsystem: string | null;
  kind: SymbolKind | null;
  loc: number | null;
}

function lookupSymbolMeta(
  db: Db,
  name: string,
  file: string | null,
): SymbolMeta {
  // Find the symbol id(s). Prefer file match if file is known.
  type Row = { id: number; subsystem: string; kind: SymbolKind; start_line: number; end_line: number };
  try {
    let rows: Row[];
    if (file !== null) {
      rows = db
        .prepare(
          `SELECT s.id AS id, f.subsystem AS subsystem, s.kind AS kind,
                  s.start_line AS start_line, s.end_line AS end_line
             FROM symbols s
             JOIN files f ON f.id = s.file_id
            WHERE s.name = ? AND f.path = ?`,
        )
        .all(name, file) as Row[];
    } else {
      rows = db
        .prepare(
          `SELECT s.id AS id, f.subsystem AS subsystem, s.kind AS kind,
                  s.start_line AS start_line, s.end_line AS end_line
             FROM symbols s
             JOIN files f ON f.id = s.file_id
            WHERE s.name = ?`,
        )
        .all(name) as Row[];
    }

    if (rows.length === 0) {
      return { unresolvedTargets: [], subsystem: null, kind: null, loc: null };
    }

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const unresolved = db
      .prepare(
        `SELECT to_name FROM edges
          WHERE from_symbol_id IN (${placeholders})
            AND kind = 'CALLS'
            AND to_symbol_id IS NULL`,
      )
      .all(...ids) as Array<{ to_name: string }>;
    // Drop stdlib/builtin call targets — `isinstance`, `len`, `getattr`,
    // `gather`, `forEach` etc. inflate the ambiguity score for every large
    // function without indicating real dynamic-dispatch risk. App-level
    // unresolved names stay (they're the ones worth flagging).
    const targets = [...new Set(unresolved.map((r) => r.to_name))]
      .filter((n) => !isStdlibName(n));
    targets.sort();

    const first = rows[0]!;
    const loc = first.end_line - first.start_line + 1;
    return { unresolvedTargets: targets, subsystem: first.subsystem, kind: first.kind, loc };
  } catch {
    return { unresolvedTargets: [], subsystem: null, kind: null, loc: null };
  }
}
