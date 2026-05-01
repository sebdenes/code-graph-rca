/**
 * NebulaLayer — soft glowing radial-gradient clouds + named-constellation
 * (file basename) labels, drawn behind cytoscape's canvas.
 *
 * One nebula per file (or per subsystem when there are many files). Each
 * cluster is rendered as two stacked radial-gradient circles (soft outer
 * cloud + brighter inner core) with `mix-blend-mode: screen` and a heavy
 * blur so the result reads as cosmic gas, not flat discs.
 *
 * Centroids are computed in cytoscape *model* space when the layout settles,
 * then projected to screen space via cy.zoom() / cy.pan() on every viewport
 * change. We update the SVG via a `transform` on the root <g>; that keeps
 * pan/zoom at 60fps because we never re-render React on viewport ticks.
 */
import { memo, useEffect, useRef } from "react";
import type { Core, NodeSingular } from "cytoscape";

const NEBULA_RADIUS_MODEL = 240;
const NEBULA_CORE_RADIUS_MODEL = 100;

/** Six handpicked nebula hues (cobalt / moss / aubergine / amber / plum / teal). */
const NEBULA_HUES: number[] = [240, 150, 280, 30, 320, 190];

/** Deterministic file-path → palette index. Stable across pans/zooms/sessions. */
function hueForPath(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) {
    h = (h * 31 + path.charCodeAt(i)) >>> 0;
  }
  return NEBULA_HUES[h % NEBULA_HUES.length] as number;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export interface FileCluster {
  /** File path (deterministic key). */
  file: string;
  /** Display label — basename. */
  label: string;
  /** Cluster centroid in cytoscape model space. */
  cx: number;
  cy: number;
  /** Hue degrees from the palette. */
  hue: number;
  /** Number of symbols in this cluster — drives label size. */
  size: number;
}

/** Compute one cluster per file by averaging member symbol positions. */
export function computeFileClusters(cy: Core): FileCluster[] {
  const groups = new Map<string, NodeSingular[]>();
  cy.nodes().forEach((n) => {
    if (n.hasClass("halo") || n.hasClass("ring")) return;
    const kind = String(n.data("kind") ?? "");
    if (kind !== "function" && kind !== "method" && kind !== "class" &&
        kind !== "interface" && kind !== "const" && kind !== "enum" &&
        kind !== "type") {
      return;
    }
    const file = n.data("file");
    if (typeof file !== "string" || file === "") return;
    const arr = groups.get(file);
    if (arr) arr.push(n);
    else groups.set(file, [n]);
  });
  const clusters: FileCluster[] = [];
  groups.forEach((nodes, file) => {
    if (nodes.length < 2) return;
    let sx = 0, sy = 0;
    for (const n of nodes) {
      const p = n.position();
      sx += p.x;
      sy += p.y;
    }
    clusters.push({
      file,
      label: basename(file),
      cx: sx / nodes.length,
      cy: sy / nodes.length,
      hue: hueForPath(file),
      size: nodes.length,
    });
  });
  // Sort largest first so big clusters render under smaller ones.
  clusters.sort((a, b) => b.size - a.size);
  return clusters;
}

interface Props {
  cy: Core | null;
  clusters: FileCluster[];
  /** When set, this file's label is rendered larger (anchor's file). */
  anchorFile?: string | null;
}

export const NebulaLayer = memo(function NebulaLayer({ cy, clusters, anchorFile }: Props) {
  const rootRef = useRef<SVGSVGElement | null>(null);
  const groupRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    if (!cy) return;
    const root = rootRef.current;
    const group = groupRef.current;
    if (!root || !group) return;

    const sync = () => {
      const z = cy.zoom();
      const p = cy.pan();
      group.setAttribute("transform", `translate(${p.x} ${p.y}) scale(${z})`);
    };
    sync();
    cy.on("viewport", sync);
    cy.on("layoutstop", sync);
    cy.on("resize", sync);
    return () => {
      cy.removeListener("viewport", sync);
      cy.removeListener("layoutstop", sync);
      cy.removeListener("resize", sync);
    };
  }, [cy, clusters]);

  // The big radius (NEBULA_RADIUS_MODEL) measured in model space — when the
  // <g> is scaled by cy.zoom(), the gradient scales with it. That's the
  // cheap way to keep the cloud "glued" to its cluster across zoom.
  return (
    <svg
      ref={rootRef}
      className="nebula-svg"
      width="100%"
      height="100%"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      <defs>
        {clusters.map((c) => (
          <radialGradient key={c.file} id={`nebula-${gradId(c.file)}`}>
            <stop offset="0%" stopColor={`hsla(${c.hue}, 80%, 50%, 0.7)`} />
            <stop offset="60%" stopColor={`hsla(${c.hue}, 70%, 35%, 0.18)`} />
            <stop offset="100%" stopColor={`hsla(${c.hue}, 80%, 30%, 0)`} />
          </radialGradient>
        ))}
      </defs>
      <g ref={groupRef}>
        {/* Outer cloud: bigger, softer. */}
        <g className="nebula-clouds">
          {clusters.map((c) => (
            <circle
              key={`out-${c.file}`}
              cx={c.cx}
              cy={c.cy}
              r={NEBULA_RADIUS_MODEL}
              fill={`url(#nebula-${gradId(c.file)})`}
            />
          ))}
        </g>
        {/* Inner core: tighter, brighter. */}
        <g className="nebula-cores">
          {clusters.map((c) => (
            <circle
              key={`in-${c.file}`}
              cx={c.cx}
              cy={c.cy}
              r={NEBULA_CORE_RADIUS_MODEL}
              fill={`url(#nebula-${gradId(c.file)})`}
            />
          ))}
        </g>
        {/* File labels — italic serif, opacity 0.42, offset radially toward
         * the canvas edge from each cluster centroid. We use the cluster's
         * angle from the global centroid as a proxy for "edge direction". */}
        <g className="nebula-file-labels">
          {labelPositions(clusters).map((pos) => (
            <text
              key={pos.file}
              x={pos.x}
              y={pos.y}
              className={
                "file-label" + (pos.file === anchorFile ? " anchor-file" : "")
              }
              textAnchor={pos.anchor}
            >
              {pos.label}
            </text>
          ))}
        </g>
      </g>
    </svg>
  );
});

function gradId(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

interface LabelPos {
  file: string;
  label: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

/** Place each cluster label out at the cluster edge, in the radial direction
 *  from the global centroid. So a cluster top-left of the canvas gets its
 *  label pushed up-and-left. */
function labelPositions(clusters: FileCluster[]): LabelPos[] {
  if (clusters.length === 0) return [];
  let mx = 0, my = 0;
  for (const c of clusters) {
    mx += c.cx;
    my += c.cy;
  }
  mx /= clusters.length;
  my /= clusters.length;
  const out: LabelPos[] = [];
  for (const c of clusters) {
    const dx = c.cx - mx;
    const dy = c.cy - my;
    const norm = Math.max(1, Math.hypot(dx, dy));
    const offset = NEBULA_RADIUS_MODEL * 0.55;
    const x = c.cx + (dx / norm) * offset;
    const y = c.cy + (dy / norm) * offset;
    const anchor: "start" | "middle" | "end" =
      dx > 18 ? "start" : dx < -18 ? "end" : "middle";
    out.push({ file: c.file, label: c.label, x, y, anchor });
  }
  return out;
}
