import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
import type { Core, ElementDefinition, EventObject } from "cytoscape";
// @ts-expect-error - cytoscape-cose-bilkent ships no types
import coseBilkent from "cytoscape-cose-bilkent";
import { graphStylesheet } from "./styles.ts";

let registered = false;
function registerOnce(): void {
  if (registered) return;
  cytoscape.use(coseBilkent);
  registered = true;
}
registerOnce();

const LAYOUT_OPTIONS = {
  name: "cose-bilkent",
  animate: false,
  randomize: false,
  nodeRepulsion: 8000,
  idealEdgeLength: 80,
  edgeElasticity: 0.45,
  gravity: 0.25,
  numIter: 2500,
} as const;

interface UseGraphArgs {
  elements: ElementDefinition[];
  selectedSymbol: { name: string; file: string | null } | null;
  scoreThreshold: number;
  subsystem: string | null;
  onSelect: (n: { name: string; file: string | null; line: number | null } | null) => void;
  onHover: (n: { name: string; rationale: string; x: number; y: number } | null) => void;
}

export function useGraph(args: UseGraphArgs) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const onSelectRef = useRef(args.onSelect);
  const onHoverRef = useRef(args.onHover);
  onSelectRef.current = args.onSelect;
  onHoverRef.current = args.onHover;

  // Mount + unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const cy = cytoscape({
      container,
      elements: args.elements,
      style: graphStylesheet,
      wheelSensitivity: 0.2,
      minZoom: 0.2,
      maxZoom: 2.5,
    });
    cyRef.current = cy;

    cy.on("tap", "node", (evt: EventObject) => {
      const n = evt.target;
      onSelectRef.current({
        name: String(n.data("name")),
        file: (n.data("file") as string) || null,
        line: typeof n.data("line") === "number" ? (n.data("line") as number) : null,
      });
    });
    cy.on("tap", (evt: EventObject) => {
      if (evt.target === cy) onSelectRef.current(null);
    });
    cy.on("mouseover", "node", (evt: EventObject) => {
      const n = evt.target;
      const pos = n.renderedPosition();
      onHoverRef.current({
        name: String(n.data("name")),
        rationale: String(n.data("rationale") ?? ""),
        x: pos.x,
        y: pos.y,
      });
    });
    cy.on("mouseout", "node", () => onHoverRef.current(null));

    cy.layout(LAYOUT_OPTIONS).run();

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
    // Only run on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update elements + re-run layout on data change.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().remove();
    cy.add(args.elements);
    cy.layout(LAYOUT_OPTIONS).run();
  }, [args.elements]);

  // Apply selection class.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.$("node:selected").unselect();
    if (!args.selectedSymbol) return;
    const target = cy.nodes().filter((n) => {
      return (
        n.data("name") === args.selectedSymbol?.name &&
        ((n.data("file") as string) || null) === (args.selectedSymbol?.file ?? null)
      );
    });
    if (target.length > 0) target.select();
  }, [args.selectedSymbol]);

  // Apply dimming filters.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().removeClass("dimmed");
      cy.edges().removeClass("dimmed");
      cy.nodes().forEach((n) => {
        const score = Number(n.data("score") ?? 0);
        const sub = String(n.data("subsystem") ?? "");
        const belowThreshold = score < args.scoreThreshold;
        const wrongSubsystem =
          args.subsystem !== null && args.subsystem.length > 0 && sub !== args.subsystem;
        const isAnchor = Boolean(n.data("isAnchor"));
        if (!isAnchor && (belowThreshold || wrongSubsystem)) {
          n.addClass("dimmed");
          n.connectedEdges().addClass("dimmed");
        }
      });
    });
  }, [args.scoreThreshold, args.subsystem, args.elements]);

  return { containerRef };
}
