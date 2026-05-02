/**
 * Pure converter: ImpactResponse → cytoscape elements for the Forward
 * Constellation. Each ImpactNode (and the seed) becomes one symbol-shaped
 * cytoscape node; edges are drawn from each node to its callers (the tree
 * already encodes forward propagation). Risk drives the FILL color via
 * `riskFill()`; the test-coverage state is stamped on `data.tested` so the
 * stylesheet can paint a green halo for tested nodes and a dashed red ring
 * for untested ones.
 *
 * Node ids are deterministic (`is:<name>@<file>:<line>`) so external code —
 * the impact-view's selectedKey sync, the file-blast-radius row click — can
 * resolve them without a separate map.
 */
import type { ElementDefinition } from "cytoscape";
import type { ImpactNode, ImpactResponse } from "@shared/api";
import type { NodePayload } from "../graph/build-elements.ts";

const PREFIX = "is:";

export function impactSymbolId(name: string, file: string, line: number): string {
  return `${PREFIX}${name}@${file}:${line}`;
}

/** Risk → fill color. cyan → amber → halo-red. Matches the Observatory tokens. */
export function riskFill(risk: number): string {
  if (risk >= 0.75) return "#ff5c6a";
  if (risk >= 0.5) return "#ffb547";
  if (risk >= 0.25) return "#ffd47a";
  return "#5cd5ff";
}

/** Distance-from-seed → display size (px). Closer = bigger. */
function sizeForDistance(distance: number, risk: number): number {
  const base = distance === 0 ? 14 : Math.max(4, 10 - distance);
  // Risk bumps it up slightly so high-risk targets are visually heavier.
  return Math.round(base + risk * 2);
}

interface BuildResult {
  elements: ElementDefinition[];
  /** cy node id → original ImpactNode (so the canvas can map clicks). */
  byCyId: Map<string, ImpactNode>;
}

export function buildImpactElements(response: ImpactResponse): BuildResult {
  const els: ElementDefinition[] = [];
  const byCyId = new Map<string, ImpactNode>();
  const seenIds = new Set<string>();

  // Seed node — synthesized as a 0-distance ImpactNode-like record.
  const seedId = impactSymbolId(
    response.seed.name,
    response.seed.file,
    response.seed.line,
  );
  const seedPayload: NodePayload & { tested?: boolean; risk?: number; distance?: number } = {
    id: seedId,
    kind: "function",
    name: response.seed.name,
    label: response.seed.name,
    file: response.seed.file,
    line: response.seed.line,
    size: sizeForDistance(0, 1),
    color: "#ff5c6a",
    symbolId: null,
    tested: true, // the seed itself isn't graded — leave its ring quiet
    risk: 1,
    distance: 0,
  };
  els.push({
    group: "nodes",
    data: seedPayload as unknown as Record<string, unknown>,
    classes: "impact-seed",
  });
  seenIds.add(seedId);
  // The seed ImpactNode is reachable via response.tree (distance 0).
  byCyId.set(seedId, response.tree);

  // Walk the tree to emit caller nodes + child edges. Iterative DFS so we
  // can terminate cleanly without stack worries on deep traces.
  const stack: ImpactNode[] = [response.tree];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const curId = impactSymbolId(cur.name, cur.file, cur.line);
    for (const child of cur.callers) {
      const cid = impactSymbolId(child.name, child.file, child.line);
      if (!seenIds.has(cid)) {
        seenIds.add(cid);
        const tested = child.testCoverage.length > 0;
        const payload: NodePayload & { tested: boolean; risk: number; distance: number } = {
          id: cid,
          kind: "function",
          name: child.name,
          label: child.name,
          file: child.file,
          line: child.line,
          size: sizeForDistance(child.distance, child.riskScore),
          color: riskFill(child.riskScore),
          symbolId: null,
          tested,
          risk: child.riskScore,
          distance: child.distance,
        };
        els.push({
          group: "nodes",
          data: payload as unknown as Record<string, unknown>,
          classes: tested ? "impact-tested" : "impact-untested",
        });
        byCyId.set(cid, child);
      }
      els.push({
        group: "edges",
        data: {
          id: `ie:${curId}->${cid}`,
          source: curId,
          target: cid,
          ekind: "CALLS",
        },
      });
      stack.push(child);
    }
  }

  return { elements: els, byCyId };
}
