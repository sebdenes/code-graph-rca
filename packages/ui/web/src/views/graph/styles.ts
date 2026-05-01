/**
 * Constellation stylesheet for the cytoscape canvas.
 *
 * Visual language: glowing dots on a deep-space background. Nodes are 4-8px
 * filled circles with an outer rim that simulates atmospheric glow. Labels
 * are mono, small, low-opacity by default — they brighten on hover and at
 * high zoom (cytoscape `zoom > 1.5` selector). Edges are 0.5px gossamer-thin
 * by default; the `.lit` class promotes them to 1.5px bright cyan rays when
 * an endpoint is hovered or selected.
 *
 * The `.halo` and `.ring` classes mark synthetic nodes added by the canvas
 * to render causal halos and recency rings; their styling is intentionally
 * minimal so they read as ambient halos rather than data points.
 *
 * Hover/selection toggles via cytoscape *classes only* (no per-element
 * style writes) so the cost is O(neighborhood) instead of O(graph).
 */
import type cytoscape from "cytoscape";

export type Stylesheet = cytoscape.StylesheetJsonBlock;

/** Constellation node fills — saturated, otherworldly. */
export const KIND_COLORS = {
  folder: "#9b6dff",
  file: "#5cd5ff",
  class: "#ffb547",
  interface: "#42e6ff",
  method: "#c084fc",
  function: "#7aa8ff",
  const: "#5dd699",
  enum: "#ff6b8b",
  type: "#ff8fc4",
  phantom: "#5a5e74",
} as const;

export type NodeKind = keyof typeof KIND_COLORS;

/** Recency rings for nodes whose owning file changed within these windows. */
export const RECENCY_COLORS = {
  d7: "#ff5c6a",
  d30: "#ffa257",
  d90: "#fade5a",
} as const;

/** Score-color ramp for causal halos: hot to cool. */
export function haloColor(score: number): string {
  // score in 0..1; hot (red) at 1.0, cool (cyan) at low.
  if (score >= 0.75) return "#ff5c6a";
  if (score >= 0.5) return "#ffa257";
  if (score >= 0.25) return "#fade5a";
  return "#5cd5ff";
}

export const STYLESHEET: Stylesheet[] = [
  // Base node — small glowing dot. Color from data.color.
  // Default labels are intentionally suppressed (empty) — labels are drawn
  // by the SmartLabels SVG overlay so we get collision avoidance + bigger
  // typography for the anchor.
  {
    selector: "node",
    style: {
      "background-color": "data(color)",
      "background-opacity": 0.95,
      label: "",
      "font-family": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      "font-size": 10,
      color: "#cfd6e6",
      "text-valign": "center",
      "text-halign": "right",
      "text-margin-x": 8,
      "text-wrap": "ellipsis",
      "text-max-width": "180px",
      "text-opacity": 0,
      "text-outline-color": "#050810",
      "text-outline-width": 2,
      width: "data(size)",
      height: "data(size)",
      // Outer atmospheric glow via a wide low-opacity border ring.
      "border-width": 3,
      "border-color": "data(color)",
      "border-opacity": 0.18,
      shape: "ellipse",
    },
  },
  // Phantom (unresolved) — italic gray label, no fill.
  {
    selector: 'node[kind = "phantom"]',
    style: {
      "background-opacity": 0,
      "border-width": 1,
      "border-color": "#5a5e74",
      "border-opacity": 0.5,
      "border-style": "dashed",
      "font-style": "italic",
      color: "#7a8092",
      "text-opacity": 0.7,
    },
  },
  // Labels become readable on zoom-in.
  {
    selector: "core",
    style: {},
  },
  // Selected node — bright 2px ring.
  {
    selector: "node.selected",
    style: {
      "border-width": 2,
      "border-color": "#eaf6ff",
      "border-opacity": 1,
      "text-opacity": 1,
      "z-index": 30,
    },
  },
  {
    selector: "node.hovered",
    style: {
      "border-width": 2,
      "border-color": "#bfe9ff",
      "border-opacity": 0.95,
      "text-opacity": 1,
      "z-index": 25,
    },
  },
  {
    selector: "node.dimmed",
    style: {
      opacity: 0.18,
      "text-opacity": 0,
    },
  },
  {
    selector: "node.hidden",
    style: { display: "none" },
  },
  {
    selector: "node.searchmiss",
    style: { opacity: 0.08, "text-opacity": 0 },
  },
  // Halo node — soft, large, low-opacity disc sitting under a scored node.
  {
    selector: "node.halo",
    style: {
      "background-color": "data(color)",
      "background-opacity": 0.18,
      "border-width": 0,
      "border-opacity": 0,
      width: "data(size)",
      height: "data(size)",
      label: "",
      "text-opacity": 0,
      events: "no",
      "z-index": 1,
      "overlay-opacity": 0,
    },
  },
  // Recency ring — sits directly on the node border.
  {
    selector: "node.ring",
    style: {
      "background-opacity": 0,
      "border-width": 1.5,
      "border-color": "data(ringColor)",
      "border-opacity": "data(ringOpacity)" as unknown as number,
      label: "",
      "text-opacity": 0,
      events: "no",
      "z-index": 5,
      "overlay-opacity": 0,
    },
  },
  // Edges — gossamer cyan default. Default opacity ~0.12 so the lit class
  // (~0.85) reads as the dramatic 5–7× contrast the mockup specifies.
  {
    selector: "edge",
    style: {
      "curve-style": "bezier",
      "line-color": "#7aa8ff",
      "line-opacity": 0.12,
      width: 0.5,
      "target-arrow-shape": "none",
    },
  },
  // Confidence weave — solid (>=0.9), dashed (>=0.7), dotted (<0.7).
  // The data attribute `weave` carries one of: "solid" | "dashed" | "dotted".
  {
    selector: 'edge[weave = "dashed"]',
    style: { "line-style": "dashed", "line-dash-pattern": [10, 6] },
  },
  {
    selector: 'edge[weave = "dotted"]',
    style: { "line-style": "dotted" },
  },
  // CONTAINS edges — the structural skeleton, very faint.
  {
    selector: 'edge[ekind = "CONTAINS"]',
    style: { "line-color": "#9b6dff", "line-opacity": 0.08, width: 0.4 },
  },
  // EXTENDS / IMPLEMENTS keep their semantic line styling but quiet.
  {
    selector: 'edge[ekind = "EXTENDS"]',
    style: { "line-color": "#ffb547", "line-opacity": 0.35 },
  },
  {
    selector: 'edge[ekind = "IMPLEMENTS"]',
    style: { "line-color": "#42e6ff", "line-opacity": 0.35 },
  },
  // Lit edge — "ray of light" through the constellation.
  // ~6× the default opacity + ~3× width so anchor-incident edges read as
  // bright cyan rays against the faded baseline (mockup spec: opacity 0.78,
  // ~5-6× brighter than non-lit). The cytoscape canvas API doesn't support
  // edge drop-shadow, so we approximate the glow by stacking the bright
  // edge atop a wider semi-transparent halo edge via an "anchor-lit"
  // variant.
  {
    selector: "edge.lit",
    style: {
      "line-color": "#5cd5ff",
      "line-opacity": 0.78,
      width: 1.6,
      "z-index": 20,
    },
  },
  // Anchor-incident edges: a slightly wider band of the same lit treatment,
  // simulating the glow without per-element shadow filters.
  {
    selector: "edge.anchor-lit",
    style: {
      "line-color": "#5cd5ff",
      "line-opacity": 0.85,
      width: 1.8,
      "z-index": 22,
    },
  },
  {
    selector: "edge.dimmed",
    style: { "line-opacity": 0.03 },
  },
  {
    selector: "edge.hidden",
    style: { display: "none" },
  },
];
