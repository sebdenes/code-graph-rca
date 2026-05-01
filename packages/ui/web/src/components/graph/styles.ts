// Cytoscape (3.33+) calls a stylesheet block `StylesheetJsonBlock`. The exported
// `cytoscape.Stylesheet[]` from the task spec corresponds to
// `cytoscape.StylesheetJsonBlock[]` in the current types.
import type cytoscape from "cytoscape";

export type Stylesheet = cytoscape.StylesheetJsonBlock;

/**
 * Cytoscape stylesheet for the RCA neighborhood graph.
 *
 * Node colors come from `data(color)` which is set per-element from `scoreColor(score)`.
 * Edge widths come from `data(width)` (`confidenceToWidth(confidence)`); dashed when
 * the call edge is unresolved or has confidence < 1.0. The anchor node has a thicker,
 * distinctive border. Filtered-out nodes (below score threshold or non-matching
 * subsystem) carry a `dimmed` class that drops opacity to 0.2.
 */
export const graphStylesheet: Stylesheet[] = [
  {
    selector: "node",
    style: {
      "background-color": "data(color)",
      label: "data(label)",
      "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
      "font-size": 10,
      color: "#0f172a",
      "text-valign": "center",
      "text-halign": "center",
      "text-wrap": "ellipsis",
      "text-max-width": "120px",
      width: "data(loc)",
      height: "data(loc)",
      "border-width": 1,
      "border-color": "#1e293b",
      "border-opacity": 0.7,
    },
  },
  {
    selector: 'node[kind = "function"]',
    style: {
      shape: "round-rectangle",
    },
  },
  {
    selector: 'node[kind = "method"]',
    style: {
      shape: "round-rectangle",
      "border-style": "double",
    },
  },
  {
    selector: 'node[kind = "class"]',
    style: {
      shape: "ellipse",
    },
  },
  {
    selector: "node[?isAnchor]",
    style: {
      "border-width": 4,
      "border-color": "#0ea5e9",
      "border-opacity": 1,
      "font-weight": 700,
      "font-size": 12,
    },
  },
  {
    selector: "node:selected",
    style: {
      "border-width": 4,
      "border-color": "#9333ea",
      "border-opacity": 1,
    },
  },
  {
    selector: "node.dimmed",
    style: {
      opacity: 0.2,
    },
  },
  {
    selector: "edge",
    style: {
      "curve-style": "bezier",
      "target-arrow-shape": "triangle",
      "line-color": "#64748b",
      "target-arrow-color": "#64748b",
      width: "data(width)",
      "line-opacity": 0.7,
      "target-arrow-fill": "filled",
      "arrow-scale": 1,
    },
  },
  {
    selector: 'edge[style = "dashed"]',
    style: {
      "line-style": "dashed",
    },
  },
  {
    selector: 'edge[style = "solid"]',
    style: {
      "line-style": "solid",
    },
  },
  {
    selector: "edge.dimmed",
    style: {
      opacity: 0.15,
    },
  },
];
