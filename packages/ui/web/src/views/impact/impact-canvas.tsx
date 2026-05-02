/**
 * ImpactCanvas — single-canvas Observatory rendering of forward-impact.
 *
 * Reuses CyCanvas + NebulaLayer + AnchorOverlay + SmartLabels from the Graph
 * view. The element converter is impact-specific (build-impact-elements):
 * one cytoscape node per ImpactNode + the seed, and edges seed → caller for
 * each direct hop. Risk is encoded as node FILL color via `riskFill()`; test
 * coverage is encoded as the node's RING via cytoscape's border style.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Core } from "cytoscape";
import type { ImpactNode, ImpactResponse } from "@shared/api";
import { CyCanvas, type CyHandle } from "../graph/cy-canvas.tsx";
import { NebulaLayer, computeFileClusters, type FileCluster } from "../graph/nebula-layer.tsx";
import { AnchorOverlay } from "../graph/anchor-overlay.tsx";
import { SmartLabels } from "../graph/smart-labels.tsx";
import type { NodePayload } from "../graph/build-elements.ts";
import { buildImpactElements, impactSymbolId } from "./build-impact-elements.ts";

interface Props {
  response: ImpactResponse;
  onSelect: (node: ImpactNode) => void;
  selectedKey: string | null;
}

export function ImpactCanvas({ response, onSelect, selectedKey }: Props) {
  const cyHandleRef = useRef<CyHandle | null>(null);
  const [cy, setCy] = useState<Core | null>(null);
  const [clusters, setClusters] = useState<FileCluster[]>([]);
  const [layoutVersion, setLayoutVersion] = useState(0);

  // Build cytoscape elements + a flat lookup of ImpactNodes by node id.
  const { elements, byCyId } = useMemo(() => buildImpactElements(response), [response]);

  // Anchor = the seed node.
  const anchorId = useMemo<string | null>(
    () => impactSymbolId(response.seed.name, response.seed.file, response.seed.line),
    [response.seed],
  );

  const anchorFile = response.seed.file;

  const onCyReady = useCallback((core: Core) => {
    // Extend the inherited graph stylesheet with impact-specific ring rules:
    //   .impact-tested → solid green halo
    //   .impact-untested → dashed red ring
    //   .impact-seed → suppress border (anchor flare overlay handles it)
    // We `update()` rather than replace the stylesheet so we keep all the
    // base graph styling (hover, selection, dimmed, etc.).
    core
      .style()
      .selector("node.impact-tested")
      .style({
        "border-width": 2,
        "border-color": "#5dd699",
        "border-opacity": 0.85,
        "border-style": "solid",
      })
      .selector("node.impact-untested")
      .style({
        "border-width": 1.5,
        "border-color": "#ff5c6a",
        "border-opacity": 0.6,
        "border-style": "dashed",
      })
      .selector("node.impact-seed")
      .style({
        "border-width": 0,
        "border-opacity": 0,
      })
      .update();
    setCy(core);
    setClusters(computeFileClusters(core));
    setLayoutVersion((v) => v + 1);
  }, []);

  const handleSelectNode = useCallback(
    (n: NodePayload) => {
      const impact = byCyId.get(n.id);
      if (impact) onSelect(impact);
    },
    [byCyId, onSelect],
  );

  // When external `selectedKey` changes, sync the cytoscape selection ring.
  useEffect(() => {
    if (!cy || !selectedKey) return;
    cy.batch(() => {
      cy.nodes().removeClass("selected");
      // selectedKey is `name@file:line`; the matching cy id is in our buildImpactElements mapping.
      cy.nodes().forEach((n) => {
        const d = n.data() as NodePayload;
        if (d.file === null || d.line === null) return;
        const k = `${d.name}@${d.file}:${d.line}`;
        if (k === selectedKey) n.addClass("selected");
      });
    });
  }, [cy, selectedKey]);

  // Persistently light the seed's outgoing edges so the lens flare reads as
  // "this is the change-source" even when nothing's hovered.
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
        elements={elements}
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

