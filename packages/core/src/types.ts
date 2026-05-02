export type Language = "typescript" | "python" | "unparsed";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "const"
  | "enum"
  | "type";

export type EdgeKind = "CALLS" | "IMPORTS" | "EXTENDS" | "IMPLEMENTS";

export type ImportKind = "named" | "default" | "namespace" | "from";

export interface FileRow {
  id: number;
  path: string;
  language: Language;
  subsystem: string;
  loc: number;
}

export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: SymbolKind;
  parent_id: number | null;
  start_line: number;
  end_line: number;
  signature: string | null;
  exported: 0 | 1;
}

export type ResolutionKind =
  | "stdlib"
  | "external_module"
  | "instance_method"
  | "unknown";

export interface EdgeRow {
  id: number;
  from_symbol_id: number;
  to_symbol_id: number | null;
  to_name: string;
  kind: EdgeKind;
  confidence: number;
  call_line: number | null;
  resolution_kind: ResolutionKind | null;
}

export interface ImportRow {
  id: number;
  file_id: number;
  local_name: string;
  source_module: string;
  source_name: string;
  kind: ImportKind;
}

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  parentName: string | null;
  startLine: number;
  endLine: number;
  signature: string | null;
  exported: boolean;
}

export interface ExtractedEdge {
  fromName: string;
  fromParentName: string | null;
  toName: string;
  toReceiverName: string | null;
  kind: EdgeKind;
  confidence: number;
  callLine: number | null;
  /**
   * Per-argument bindings at a CALLS edge's call site. Empty for non-call
   * edges (EXTENDS / IMPLEMENTS / IMPORTS). Carried side-by-side with the
   * edge so `insertExtracted` can persist them after the edge row exists.
   */
  argBindings?: ExtractedArgBinding[];
}

/** What kind of expression appears in argument position at a call site. */
export type ArgSourceKind =
  | "identifier"
  | "literal"
  | "member"
  | "call"
  | "spread"
  | "other";

export interface ExtractedArgBinding {
  position: number;
  sourceKind: ArgSourceKind;
  sourceText: string;
}

export interface ExtractedParam {
  /** 0-based position. */
  position: number;
  name: string;
  /** Raw type annotation source text, or null when absent. */
  typeText: string | null;
  hasDefault: boolean;
}

/**
 * A formal-parameter row keyed back to its enclosing symbol via the same
 * (kind, parentName, name) tuple `insertExtracted` uses for edges. Carried on
 * `ExtractedSymbol`-side rather than `ExtractedFile` to keep the symbol/param
 * association explicit through the pipeline.
 */
export interface ExtractedSymbolParams {
  ownerKind: SymbolKind;
  ownerName: string;
  /** Enclosing class name when the owner is a method, else null. */
  ownerParentName: string | null;
  params: ExtractedParam[];
}

export interface ExtractedImport {
  localName: string;
  sourceModule: string;
  sourceName: string;
  kind: ImportKind;
}

export interface ExtractedFile {
  path: string;
  language: Language;
  loc: number;
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
  imports: ExtractedImport[];
  /**
   * Formal-parameter rows. One entry per function/method symbol that has
   * any parameters (or even zero — we still record the empty list to
   * disambiguate from "not extracted yet"). Populated for TypeScript only.
   */
  symbolParams?: ExtractedSymbolParams[];
}

/**
 * Edge kind in the `pathBetween` traversal: a regular CALLS edge from the
 * graph, or an ARG_BIND edge that follows a value flowing from a producer
 * symbol into the parameter of a callee via an argument expression.
 */
export type PathEdgeKind = "CALLS" | "ARG_BIND";

export interface PathStep {
  name: string;
  file: string | null;
  line: number | null;
  /** How this step was reached from the previous one. `null` on the seed. */
  edgeKind: PathEdgeKind | null;
}

export interface Definition {
  name: string;
  kind: SymbolKind;
  file: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  exported: boolean;
  language: Language;
  subsystem: string;
}

export interface RecentChange {
  commit: string;
  date: string;   // ISO 8601
  author: string;
  subject: string;
  daysAgo: number; // computed at attach time, integer rounded
}

export interface CallerNode {
  name: string;
  file: string;
  line: number;
  confidence: number;
  /** Populated when caller/callee queries are run with hydrateRecency. */
  recentChanges?: RecentChange[];
  callers: CallerNode[];
}

export interface CallerTree {
  target: string;
  callers: CallerNode[];
}

export interface CalleeNode {
  name: string;
  resolved: boolean;
  file: string | null;
  line: number | null;
  confidence: number;
  /**
   * For unresolved callees, why we couldn't resolve them. Null for resolved
   * edges. Lets downstream scoring/LLM stages distinguish stdlib noise from
   * truly missing symbols.
   */
  resolutionKind?: ResolutionKind | null;
  /** Populated when caller/callee queries are run with hydrateRecency. */
  recentChanges?: RecentChange[];
  callees: CalleeNode[];
}

export interface CalleeTree {
  source: string;
  callees: CalleeNode[];
}

/**
 * A single ranked entry in the causal chain. Produced by the scorer (`src/rca/causal.ts`)
 * from the union of caller/callee neighborhoods + recency + unresolved-edge hints.
 */
export interface CausalCandidate {
  name: string;
  file: string | null;
  line: number | null;
  /** Symbol kind from the indexed graph; null when out of scope. */
  kind: SymbolKind | null;
  /** Symbol body length in lines (end_line - start_line + 1); null when unknown. */
  loc: number | null;
  /** Subsystem the symbol's file belongs to; null when out of scope. */
  subsystem: string | null;
  /** Direction relative to the anchor: caller, callee, or the anchor itself. */
  role: "anchor" | "caller" | "callee";
  /** Hop distance from the anchor. 0 = anchor, 1 = direct, 2+ = transitive. */
  distance: number;
  /** Final composite score; higher = more likely to be the causal site. */
  score: number;
  /** Per-signal contributions; useful for the LLM to see *why* it's ranked here. */
  signals: {
    recencyScore: number;
    proximityScore: number;
    ambiguityScore: number;
    coChangeScore: number;
    subsystemScore: number;
    complexityScore: number;
  };
  /** Human-readable rationale, one sentence. */
  rationale: string;
  /** Recent changes attached to this node, if any. */
  recentChanges: RecentChange[];
  /** Names of unresolved outgoing call edges from this node — grep-bait for the LLM. */
  unresolvedCallTargets: string[];
}

export interface SymbolSummary {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature: string | null;
  exported: boolean;
}

export interface GitChange {
  commit: string;
  author: string;
  date: string;
  subject: string;
  file: string;
  symbolName: string;
}
