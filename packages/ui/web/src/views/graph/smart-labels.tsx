/**
 * SmartLabels — selective node labels with 8-direction collision avoidance.
 *
 * Cytoscape's per-node labels collide horribly on dense clusters, so we
 * render labels in our own SVG overlay above the canvas. The label set is:
 *   - the anchor (always)
 *   - top-N per file by edge degree (N = TOP_PER_FILE)
 *
 * For each label we try 8 candidate offsets (top, top-right, ...). The first
 * placement that doesn't intersect an already-placed label wins; if all 8
 * collide, the label is dropped rather than allowed to pile up.
 *
 * The expensive part is the 8-direction loop. We cache the layout per
 * `(layoutVersion, anchorId)` so pan/zoom only update the SVG transform on
 * the root <g>, never recompute placements.
 */
import { memo, useEffect, useMemo, useRef } from "react";
import type { Core } from "cytoscape";

const TOP_PER_FILE = 5;

interface Props {
  cy: Core | null;
  /** Bumps every time the layout settles or selection changes — invalidates
   *  the cached placements. */
  layoutVersion: number;
  anchorId: string | null;
}

interface PlacedLabel {
  id: string;
  name: string;
  /** Anchor (text-anchor) for the label. */
  anchor: "start" | "middle" | "end";
  /** Cytoscape *model-space* x,y of the *node* (label is rendered relative
   *  via dx/dy in screen space, applied after the model-space transform). */
  modelX: number;
  modelY: number;
  /** Pixel offset (screen space) from the node center. */
  dx: number;
  dy: number;
  isAnchor: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DIRECTIONS: Array<{ dx: number; dy: number; anchor: "start" | "middle" | "end" }> = [
  { dx: 0, dy: -16, anchor: "middle" }, // top
  { dx: 14, dy: -10, anchor: "start" }, // top-right
  { dx: 14, dy: 4, anchor: "start" }, // right
  { dx: 14, dy: 16, anchor: "start" }, // bot-right
  { dx: 0, dy: 20, anchor: "middle" }, // bottom
  { dx: -14, dy: 16, anchor: "end" }, // bot-left
  { dx: -14, dy: 4, anchor: "end" }, // left
  { dx: -14, dy: -10, anchor: "end" }, // top-left
];

function rectsOverlap(a: Rect, b: Rect, pad = 4): boolean {
  return !(
    a.x + a.w + pad < b.x ||
    b.x + b.w + pad < a.x ||
    a.y + a.h + pad < b.y ||
    b.y + b.h + pad < a.y
  );
}

function tryPlace(
  name: string,
  dx: number,
  dy: number,
  anchor: "start" | "middle" | "end",
  isAnchor: boolean,
  baseX: number,
  baseY: number,
): Rect & { dx: number; dy: number } {
  const charW = isAnchor ? 7.4 : 6.2;
  const w = name.length * charW;
  const h = isAnchor ? 14 : 12;
  let left = baseX + dx;
  if (anchor === "middle") left = baseX + dx - w / 2;
  else if (anchor === "end") left = baseX + dx - w;
  const top = baseY + dy - h * 0.85;
  return { x: left, y: top, w, h, dx, dy };
}

/** Pick which symbols deserve a label and place them. */
function computePlacements(
  cy: Core,
  anchorId: string | null,
): PlacedLabel[] {
  // Bucket symbol nodes by file, sort each by degree desc, take top-N.
  const byFile = new Map<string, Array<{ id: string; name: string; degree: number; x: number; y: number; size: number }>>();
  cy.nodes().forEach((n) => {
    if (n.hasClass("halo") || n.hasClass("ring")) return;
    const kind = String(n.data("kind") ?? "");
    if (kind === "folder" || kind === "file" || kind === "phantom") return;
    const file = n.data("file");
    if (typeof file !== "string" || file === "") return;
    const pos = n.position();
    const arr = byFile.get(file);
    const entry = {
      id: n.id(),
      name: String(n.data("name") ?? ""),
      degree: n.connectedEdges().length,
      x: pos.x,
      y: pos.y,
      size: Number(n.data("size") ?? 6),
    };
    if (arr) arr.push(entry);
    else byFile.set(file, [entry]);
  });

  const chosen = new Set<string>();
  if (anchorId) chosen.add(anchorId);
  byFile.forEach((arr) => {
    arr.sort((a, b) => b.degree - a.degree);
    for (let i = 0; i < Math.min(TOP_PER_FILE, arr.length); i++) {
      chosen.add(arr[i]!.id);
    }
  });

  // Assemble candidates with metadata, anchor first.
  const all = [...byFile.values()].flat();
  const candidates = all
    .filter((c) => chosen.has(c.id))
    .sort((a, b) => {
      if (a.id === anchorId) return -1;
      if (b.id === anchorId) return 1;
      return b.degree - a.degree;
    });

  // Convert model-space positions to screen space for collision testing,
  // since the label rectangles are screen-px.
  const z = cy.zoom();
  const pan = cy.pan();
  const placedRects: Rect[] = [];
  const placed: PlacedLabel[] = [];
  for (const c of candidates) {
    const isAnchor = c.id === anchorId;
    const sx = c.x * z + pan.x;
    const sy = c.y * z + pan.y;
    const r = c.size / 2;

    if (isAnchor) {
      // Special placement: top-right, far enough to clear the lens flare.
      const rect = tryPlace(c.name, 32, -34, "start", true, sx, sy);
      placedRects.push(rect);
      placed.push({
        id: c.id,
        name: c.name,
        anchor: "start",
        modelX: c.x,
        modelY: c.y,
        dx: 32,
        dy: -34,
        isAnchor: true,
      });
      continue;
    }

    let chosenDir: { dx: number; dy: number; anchor: "start" | "middle" | "end" } | null = null;
    for (const dir of DIRECTIONS) {
      const dy = dir.dy < 0 ? dir.dy - r * 0.4 : dir.dy > 0 ? dir.dy + r * 0.4 : dir.dy;
      const dx = dir.dx === 0 ? 0 : dir.dx > 0 ? dir.dx + r * 0.4 : dir.dx - r * 0.4;
      const rect = tryPlace(c.name, dx, dy, dir.anchor, false, sx, sy);
      if (!placedRects.some((p) => rectsOverlap(p, rect))) {
        chosenDir = { dx, dy, anchor: dir.anchor };
        placedRects.push(rect);
        break;
      }
    }
    if (chosenDir) {
      placed.push({
        id: c.id,
        name: c.name,
        anchor: chosenDir.anchor,
        modelX: c.x,
        modelY: c.y,
        dx: chosenDir.dx,
        dy: chosenDir.dy,
        isAnchor: false,
      });
    }
  }
  return placed;
}

export const SmartLabels = memo(function SmartLabels({ cy, layoutVersion, anchorId }: Props) {
  const rootRef = useRef<SVGSVGElement | null>(null);
  const groupRef = useRef<SVGGElement | null>(null);

  // Recompute placements only when layout/anchor changes — never on pan/zoom.
  const placements = useMemo(() => {
    if (!cy) return [] as PlacedLabel[];
    return computePlacements(cy, anchorId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cy, anchorId, layoutVersion]);

  useEffect(() => {
    if (!cy) return;
    const root = rootRef.current;
    if (!root) return;
    // Each label is positioned via a per-text matrix: pan + (modelX*z, modelY*z) + (dx, dy).
    // We build that on every viewport tick by walking the group's children.
    const sync = () => {
      const z = cy.zoom();
      const pan = cy.pan();
      if (!groupRef.current) return;
      const children = groupRef.current.children;
      for (let i = 0; i < children.length; i++) {
        const el = children[i] as SVGTextElement | undefined;
        if (!el) continue;
        const mxStr = el.getAttribute("data-mx");
        const myStr = el.getAttribute("data-my");
        const dxStr = el.getAttribute("data-dx");
        const dyStr = el.getAttribute("data-dy");
        if (mxStr === null || myStr === null || dxStr === null || dyStr === null) continue;
        const mx = Number(mxStr);
        const my = Number(myStr);
        const dx = Number(dxStr);
        const dy = Number(dyStr);
        const x = mx * z + pan.x + dx;
        const y = my * z + pan.y + dy;
        el.setAttribute("x", String(x));
        el.setAttribute("y", String(y));
      }
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
  }, [cy, placements]);

  return (
    <svg
      ref={rootRef}
      className="smart-labels-svg"
      width="100%"
      height="100%"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 6,
      }}
    >
      <g ref={groupRef}>
        {placements.map((p) => (
          <text
            key={p.id}
            data-mx={p.modelX}
            data-my={p.modelY}
            data-dx={p.dx}
            data-dy={p.dy}
            textAnchor={p.anchor}
            className={"star-label" + (p.isAnchor ? " anchor" : "")}
          >
            {p.name}
          </text>
        ))}
      </g>
    </svg>
  );
});
