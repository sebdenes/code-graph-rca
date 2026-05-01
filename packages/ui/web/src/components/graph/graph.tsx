import { useState } from "react";
import type { ElementDefinition } from "cytoscape";
import { useGraph } from "./use-graph.ts";
import "./graph.css";

interface Props {
  elements: ElementDefinition[];
  selectedSymbol: { name: string; file: string | null } | null;
  scoreThreshold: number;
  subsystem: string | null;
  onSelect: (n: { name: string; file: string | null; line: number | null } | null) => void;
}

interface HoverState {
  name: string;
  rationale: string;
  x: number;
  y: number;
}

export function Graph(props: Props) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const { containerRef } = useGraph({
    elements: props.elements,
    selectedSymbol: props.selectedSymbol,
    scoreThreshold: props.scoreThreshold,
    subsystem: props.subsystem,
    onSelect: props.onSelect,
    onHover: setHover,
  });

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="cy-host cy-container" />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 max-w-xs rounded border border-border bg-background/95 px-2 py-1 text-xs shadow"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <div className="font-mono font-semibold">{hover.name}</div>
          {hover.rationale && (
            <div className="mt-0.5 text-muted-foreground">{hover.rationale}</div>
          )}
        </div>
      )}
    </div>
  );
}
