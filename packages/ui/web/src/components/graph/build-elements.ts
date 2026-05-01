import type { ElementDefinition } from "cytoscape";
import type { CallerTree, CalleeTree, CallerNode, CalleeNode } from "code-graph-rca";
import type { RcaSnapshot } from "@shared/api";
import { scoreColor, confidenceToWidth } from "../../lib/utils.ts";

/**
 * Build a flat list of cytoscape elements (nodes + edges) for the RCA neighborhood
 * around `rca.primarySymbol`. Caller subtree provides depth-2 callers; callee subtree
 * provides depth-1 callees. Nodes are deduped by `${file}:${name}`. Each node carries
 * the score, score color, kind, file, line, rationale, and (optionally) loc/subsystem.
 */
export function buildElements(
  rca: RcaSnapshot,
  callers: CallerTree | null,
  callees: CalleeTree | null,
): ElementDefinition[] {
  const nodes = new Map<string, ElementDefinition>();
  const edges: ElementDefinition[] = [];

  const candidateByKey = new Map<string, RcaSnapshot["causalCandidates"][number]>();
  for (const c of rca.causalCandidates) {
    candidateByKey.set(keyOf(c.file, c.name), c);
  }

  const anchorName = rca.primarySymbol ?? "(anchor)";
  const anchorCandidate = rca.causalCandidates.find((c) => c.role === "anchor")
    ?? rca.causalCandidates.find((c) => c.name === rca.primarySymbol);
  const anchorFile = anchorCandidate?.file ?? null;
  const anchorKey = keyOf(anchorFile, anchorName);
  upsertNode(nodes, {
    id: anchorKey,
    name: anchorName,
    file: anchorFile,
    line: anchorCandidate?.line ?? null,
    role: "anchor",
    kind: candKindOrInfer(anchorCandidate, anchorName),
    loc: anchorCandidate?.loc ?? undefined,
    subsystem: anchorCandidate?.subsystem ?? null,
    score: anchorCandidate?.score ?? 0,
    rationale: anchorCandidate?.rationale ?? "Anchor symbol for RCA",
    isAnchor: true,
  });

  if (callers) {
    walkCallers(callers.callers, anchorKey, anchorName, nodes, edges, candidateByKey, 0);
  }
  if (callees) {
    walkCallees(callees.callees, anchorKey, anchorName, nodes, edges, candidateByKey, 0);
  }

  // Promote any candidate not already in the graph (e.g. transitive callers beyond
  // the depth, or callees that didn't resolve into the tree).
  for (const c of rca.causalCandidates) {
    const k = keyOf(c.file, c.name);
    if (!nodes.has(k)) {
      upsertNode(nodes, {
        id: k,
        name: c.name,
        file: c.file,
        line: c.line,
        role: c.role,
        kind: candKindOrInfer(c, c.name),
        loc: c.loc ?? undefined,
        subsystem: c.subsystem ?? null,
        score: c.score,
        rationale: c.rationale,
        isAnchor: false,
      });
    }
  }

  return [...nodes.values(), ...edges];
}

interface NodeInput {
  id: string;
  name: string;
  file: string | null;
  line: number | null;
  role: "anchor" | "caller" | "callee";
  kind: "function" | "method" | "class";
  score: number;
  rationale: string;
  isAnchor: boolean;
  loc?: number | undefined;
  subsystem?: string | null | undefined;
}

function upsertNode(map: Map<string, ElementDefinition>, n: NodeInput): void {
  if (map.has(n.id)) return;
  map.set(n.id, {
    group: "nodes",
    data: {
      id: n.id,
      name: n.name,
      label: n.name,
      file: n.file ?? "",
      line: n.line ?? 0,
      role: n.role,
      kind: n.kind,
      score: n.score,
      color: scoreColor(n.score),
      rationale: n.rationale,
      isAnchor: n.isAnchor,
      loc: clampLoc(n.loc ?? 0),
      subsystem: n.subsystem ?? "",
    },
  });
}

function clampLoc(loc: number): number {
  if (loc <= 0) return 50;
  return Math.max(30, Math.min(100, loc));
}

function walkCallers(
  list: CallerNode[],
  parentKey: string,
  parentName: string,
  nodes: Map<string, ElementDefinition>,
  edges: ElementDefinition[],
  candidateByKey: Map<string, RcaSnapshot["causalCandidates"][number]>,
  depth: number,
): void {
  if (depth >= 2) return;
  for (const c of list) {
    const k = keyOf(c.file, c.name);
    const cand = candidateByKey.get(k);
    upsertNode(nodes, {
      id: k,
      name: c.name,
      file: c.file,
      line: c.line,
      role: "caller",
      // Prefer real kind/loc/subsystem from the candidate; fall back to name-shape inference only when out of scope.
      kind: candKindOrInfer(cand, c.name),
      loc: cand?.loc ?? undefined,
      subsystem: cand?.subsystem ?? null,
      score: cand?.score ?? 0,
      rationale: cand?.rationale ?? `Caller of ${parentName}`,
      isAnchor: false,
    });
    edges.push(makeEdge(k, parentKey, c.confidence, true));
    if (c.callers && c.callers.length > 0) {
      walkCallers(c.callers, k, c.name, nodes, edges, candidateByKey, depth + 1);
    }
  }
}

function walkCallees(
  list: CalleeNode[],
  parentKey: string,
  parentName: string,
  nodes: Map<string, ElementDefinition>,
  edges: ElementDefinition[],
  candidateByKey: Map<string, RcaSnapshot["causalCandidates"][number]>,
  depth: number,
): void {
  if (depth >= 1) return;
  for (const c of list) {
    const k = keyOf(c.file, c.name);
    const cand = candidateByKey.get(k);
    upsertNode(nodes, {
      id: k,
      name: c.name,
      file: c.file,
      line: c.line,
      role: "callee",
      kind: candKindOrInfer(cand, c.name),
      loc: cand?.loc ?? undefined,
      subsystem: cand?.subsystem ?? null,
      score: cand?.score ?? 0,
      rationale: cand?.rationale ?? (c.resolved ? `Callee of ${parentName}` : `Unresolved call from ${parentName}`),
      isAnchor: false,
    });
    edges.push(makeEdge(parentKey, k, c.confidence, c.resolved));
    if (c.callees && c.callees.length > 0) {
      walkCallees(c.callees, k, c.name, nodes, edges, candidateByKey, depth + 1);
    }
  }
}

function makeEdge(source: string, target: string, confidence: number, resolved: boolean): ElementDefinition {
  return {
    group: "edges",
    data: {
      id: `${source}->${target}`,
      source,
      target,
      confidence,
      width: confidenceToWidth(confidence),
      style: confidence < 1 || !resolved ? "dashed" : "solid",
    },
  };
}

function candKindOrInfer(
  cand: RcaSnapshot["causalCandidates"][number] | undefined,
  name: string,
): "function" | "method" | "class" {
  // CausalCandidate now carries the real kind from the indexed graph. Map the
  // full SymbolKind union down to the three node shapes Cytoscape distinguishes.
  if (cand?.kind) {
    if (cand.kind === "method") return "method";
    if (cand.kind === "class" || cand.kind === "interface") return "class";
    return "function";
  }
  return inferKindFromName(name);
}

function inferKindFromName(name: string): "function" | "method" | "class" {
  // Convention: `Class.method` → method; CapitalizedSingleWord → class; otherwise function.
  if (name.includes(".")) return "method";
  const head = name.split(/[<(]/)[0] ?? name;
  if (head.length > 0 && head[0] === head[0]?.toUpperCase() && /^[A-Z][A-Za-z0-9_]*$/.test(head)) {
    return "class";
  }
  return "function";
}

function keyOf(file: string | null, name: string): string {
  return `${file ?? "?"}:${name}`;
}
