/**
 * RcaCanvas — Observatory rendering of the RCA neighborhood.
 *
 * Mirrors the Impact view's `impact-canvas.tsx`: wraps the same `CyCanvas`,
 * `NebulaLayer`, `AnchorOverlay`, and `SmartLabels` primitives that the Graph
 * tab uses, so the RCA middle column reads as glowing dots + lens flare +
 * nebulas instead of the old gray-box stylesheet from `components/graph/`.
 *
 * The rca-view continues to build elements via `components/graph/build-elements.ts`,
 * which produces nodes carrying `data.loc` and `data.color` but no `data.size`.
 * The Observatory stylesheet binds node width/height to `data(size)`, so we
 * adapt at the boundary: `adaptElements()` maps `loc → size` (clamped) and
 * stamps a `kind` the smart-labels / nebula-layer recognise. The original
 * RCA-specific data (score, rationale, role, isAnchor) is preserved on the
 * node so existing click/select wiring keeps working.
 *
 * Imports the Observatory stylesheets so this view renders correctly even when
 * the user lands on /rca first (without having visited Graph to load them).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Core, ElementDefinition } from "cytoscape";
import { CyCanvas, type CyHandle } from "../graph/cy-canvas.tsx";
import {
  NebulaLayer,
  computeFileClusters,
  type FileCluster,
} from "../graph/nebula-layer.tsx";
import { AnchorOverlay } from "../graph/anchor-overlay.tsx";
import { SmartLabels } from "../graph/smart-labels.tsx";
import type { NodePayload } from "../graph/build-elements.ts";
import "../graph/graph.css";
import "../graph/observatory.css";

interface SelectedSymbol {
  name: string;
  file: string | null;
  line: number | null;
}

interface Props {
  elements: ElementDefinition[];
  selectedSymbol: SelectedSymbol | null;
  scoreThreshold: number;
  subsystem: string | null;
  onSelect: (s: SelectedSymbol) => void;
}

/**
 * Map LOC → display size (px). Same log curve as `views/graph/build-elements.ts`
 * so RCA dots visually match Graph dots.
 */
function clampSize(loc: number, min = 4, max = 8): number {
  if (!Number.isFinite(loc) || loc <= 0) return min;
  const v = Math.log10(loc + 1) * 2;
  return Math.max(min, Math.min(max, Math.round(min + v)));
}

/**
 * Adapt rca-view's elements (from `components/graph/build-elements.ts`) to the
 * shape the Observatory stylesheet + overlays expect. Mutation-free: returns
 * fresh ElementDefinition objects with `data.size` derived from `data.loc`.
 */
function adaptElements(
  els: ElementDefinition[],
  scoreThreshold: number,
  subsystem: string | null,
): ElementDefinition[] {
  return els.map((el) => {
    if (el.group === "edges") return el;
    const d = el.data as Record<string, unknown>;
    const loc = typeof d.loc === "number" ? d.loc : 0;
    const score = typeof d.score === "number" ? d.score : 0;
    const sub = typeof d.subsystem === "string" ? d.subsystem : "";
    const dimByScore = score > 0 && score < scoreThreshold;
    const dimBySub = subsystem !== null && subsystem !== "" && sub !== subsystem;
    const classes: string[] = [];
    if (dimByScore || dimBySub) classes.push("dimmed");
    return {
      ...el,
      data: {
        ...d,
        size: clampSize(loc),
      },
      classes: classes.join(" "),
    };
  });
}

/** Cytoscape node id used by `components/graph/build-elements.ts`. */
function rcaSymbolId(file: string | null, name: string): string {
  return `${file ?? "?"}:${name}`;
}

export function RcaCanvas({
  elements,
  selectedSymbol,
  scoreThreshold,
  subsystem,
  onSelect,
}: Props) {
  const cyHandleRef = useRef<CyHandle | null>(null);
  const [cy, setCy] = useState<Core | null>(null);
  const [clusters, setClusters] = useState<FileCluster[]>([]);
  const [layoutVersion, setLayoutVersion] = useState(0);

  const adapted = useMemo(
    () => adaptElements(elements, scoreThreshold, subsystem),
    [elements, scoreThreshold, subsystem],
  );

  // Anchor = the node flagged with isAnchor: true by build-elements.
  const { anchorId, anchorFile } = useMemo(() => {
    for (const el of elements) {
      if (el.group === "edges") continue;
      const d = el.data as Record<string, unknown>;
      if (d.isAnchor === true) {
        const file = typeof d.file === "string" && d.file !== "" ? d.file : null;
        const name = typeof d.name === "string" ? d.name : "";
        return { anchorId: rcaSymbolId(file, name), anchorFile: file };
      }
    }
    return { anchorId: null as string | null, anchorFile: null as string | null };
  }, [elements]);

  const onCyReady = useCallback((core: Core) => {
    setCy(core);
    setClusters(computeFileClusters(core));
    setLayoutVersion((v) => v + 1);
  }, []);

  const handleSelectNode = useCallback(
    (n: NodePayload) => {
      onSelect({
        name: n.name,
        file: n.file ?? null,
        line: n.line ?? null,
      });
    },
    [onSelect],
  );

  // Sync the external `selectedSymbol` into a cytoscape `.selected` ring.
  useEffect(() => {
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().removeClass("selected");
      if (!selectedSymbol) return;
      const id = rcaSymbolId(selectedSymbol.file, selectedSymbol.name);
      const n = cy.getElementById(id);
      if (!n.empty()) n.addClass("selected");
    });
  }, [cy, selectedSymbol]);

  // Persistently light the anchor's incident edges so the lens flare reads as
  // "this is the prime suspect" even when nothing is hovered.
  useEffect(() => {
    if (!cy || !anchorId) return;
    cy.batch(() => {
      cy.edges().removeClass("anchor-lit").removeClass("lit");
      const seed = cy.getElementById(anchorId);
      if (!seed.empty()) {
        seed.connectedEdges().addClass("anchor-lit").addClass("lit");
      }
    });
  }, [cy, anchorId, layoutVersion]);

  return (
    <>
      <NebulaLayer cy={cy} clusters={clusters} anchorFile={anchorFile} />
      <CyCanvas
        ref={cyHandleRef}
        elements={adapted}
        rca={null}
        onSelectNode={handleSelectNode}
        onHoverNode={() => {}}
        onReady={onCyReady}
      />
      <AnchorOverlay cy={cy} anchorId={anchorId} />
      <SmartLabels cy={cy} layoutVersion={layoutVersion} anchorId={anchorId} />
    </>
  );
}
