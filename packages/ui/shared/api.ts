/**
 * Shared API contract between server and web. Both sides import from this file
 * so endpoint shapes stay in lockstep.
 */

import type {
  CallerTree,
  CalleeTree,
  CausalCandidate,
  Definition,
  GitChange,
  RecentChange,
  SymbolSummary,
} from "code-graph-rca";

export interface SessionSummary {
  id: string;                  // stable id (basename of the .sqlite file, sans ext)
  path: string;                // absolute path to the .sqlite file
  repoRoot: string | null;     // recovered from the indexed file paths if possible
  createdAt: string;           // ISO mtime of the .sqlite file
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  primarySymbol: string | null;
  rcaAvailable: boolean;       // true if a sibling .rca.json exists with the RcaResult
}

export interface SessionsResponse {
  sessions: SessionSummary[];
}

export interface RcaSnapshot {
  primarySymbol: string | null;
  scope: { files: string[]; symbolCount: number; edgeCount: number };
  causalCandidates: CausalCandidate[];
  firstHypothesis: string | null;
  graphContext: string;
  prompt: string;
  notes: string[];
}

export type QueryName = "definitionOf" | "callersOf" | "calleesOf" | "symbolsInFile" | "recentlyChangedNear";

export interface QueryRequest {
  name: QueryName;
  args: Record<string, unknown>;
}

export type QueryResponse =
  | { name: "definitionOf"; result: Definition[] }
  | { name: "callersOf"; result: CallerTree }
  | { name: "calleesOf"; result: CalleeTree }
  | { name: "symbolsInFile"; result: SymbolSummary[] }
  | { name: "recentlyChangedNear"; result: GitChange[] };

export interface SourceResponse {
  path: string;
  language: "typescript" | "python" | "unparsed";
  content: string;
  loc: number;
}

export interface BlameLine {
  line: number;
  commit: string;
  author: string;
  date: string;
  subject: string;
}

export interface BlameResponse {
  path: string;
  lines: BlameLine[];
}

export interface DiffResponse {
  commit: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{ path: string; additions: number; deletions: number; patch: string }>;
}

/**
 * The whole-scope code knowledge graph — the primary visual artifact.
 * Independent of any RCA invocation.
 */
export interface GraphFileNode {
  id: number;
  path: string;
  language: "typescript" | "python" | "unparsed";
  subsystem: string;
  loc: number;
}

export interface GraphSymbolNode {
  id: number;
  name: string;
  kind: "function" | "method" | "class" | "interface" | "const" | "enum" | "type";
  fileId: number;
  startLine: number;
  endLine: number;
  signature: string | null;
  exported: boolean;
  parentName: string | null;
  /** Up to ~10 lines of the symbol body, for rendering inside the node. */
  bodyPreview: string;
}

export interface GraphEdgeRow {
  id: number;
  fromSymbolId: number;
  toSymbolId: number | null;
  toName: string;
  kind: "CALLS" | "IMPORTS" | "EXTENDS" | "IMPLEMENTS";
  confidence: number;
  callLine: number | null;
}

export interface GraphResponse {
  files: GraphFileNode[];
  symbols: GraphSymbolNode[];
  edges: GraphEdgeRow[];
  /** True when the response was capped by `maxSymbols`; client can paginate further. */
  truncated: boolean;
}

export interface ImpactRequest {
  symbolName: string;
  /** Optional file disambiguator when multiple symbols share a name. */
  file?: string;
  /** Walk depth for forward-impact callers. Default 3, max 5. */
  depth?: number;
}

export interface ImpactNode {
  name: string;
  file: string;
  line: number;
  /** Hop distance from the changed symbol; 0 = the seed itself. */
  distance: number;
  /** 0..1 — heuristic risk of breaking this caller if the seed changes. */
  riskScore: number;
  /** Names of tests in the same file or subsystem that exercise this node, if any. */
  testCoverage: string[];
  /** Recent commit history attached to the node. */
  recentChanges: RecentChange[];
  /** Direct callers of this node (one hop deeper). */
  callers: ImpactNode[];
}

export interface ImpactResponse {
  seed: { name: string; file: string; line: number };
  /** Flat list of all affected nodes for table view. */
  nodes: ImpactNode[];
  /** Tree rooted at the seed, callers as children. */
  tree: ImpactNode;
  /** Summary risk: max riskScore across the tree. */
  maxRisk: number;
}

export type LiveEvent =
  | { kind: "reindex-start"; reason: string }
  | { kind: "reindex-done"; durationMs: number; symbolCount: number; edgeCount: number }
  | { kind: "file-changed"; path: string };
