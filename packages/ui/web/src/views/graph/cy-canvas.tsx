/**
 * Cytoscape host — Constellation edition.
 *
 * Layout pipeline (the perf fix):
 *   1. Initial paint uses cytoscape's built-in `concentric` layout —
 *      synchronous, ~5-50ms even for 1500 nodes. Big nodes (high LOC) sit
 *      inner; smaller satellites orbit outward. The user sees the graph
 *      immediately, in a star-map arrangement that matches the theme.
 *   2. After first paint, we defer a cose-bilkent run via
 *      `requestIdleCallback` (fall back to `setTimeout(50)` in browsers
 *      without it). cose-bilkent runs with `animate:'end'` so the user
 *      watches the constellation settle into its force-directed cluster.
 *   3. A 4-second wall-clock guard wraps the cose-bilkent run; if the
 *      `layoutready` callback hasn't fired by then we cancel and warn,
 *      leaving the user with the (still usable) concentric layout. This
 *      prevents the page from freezing on pathological graphs.
 *
 * Halo / ring overlay:
 *   We render causal halos and recency rings as *extra cytoscape nodes*
 *   pinned to each scored or recently-changed real node. This avoids any
 *   DOM-overlay reprojection on pan/zoom — cytoscape moves the halo nodes
 *   for us. They're tagged `.halo` and `.ring`, lock=true, events="no" so
 *   they don't intercept clicks. They live in a separate parent-less group
 *   and never appear in any selector that targets data nodes.
 *
 * Hover/selection toggles use cytoscape *classes only*: `.lit` on edges,
 * `.dimmed` / `.hovered` on nodes — never per-element style writes.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import cytoscape from "cytoscape";
import type { Core, ElementDefinition, EventObject, NodeSingular } from "cytoscape";
// @ts-expect-error - cytoscape-cose-bilkent ships no types
import coseBilkent from "cytoscape-cose-bilkent";
import type { RcaSnapshot } from "@shared/api";
import { STYLESHEET, RECENCY_COLORS, haloColor } from "./styles.ts";
import type { NodePayload } from "./build-elements.ts";

let registered = false;
function registerOnce(): void {
  if (registered) return;
  cytoscape.use(coseBilkent);
  registered = true;
}

/**
 * Concentric layout — used for first paint. Synchronous and fast.
 * Bigger nodes (more LOC, captured in `data.size`) sit inner; smaller
 * symbols orbit outward.
 */
const CONCENTRIC_LAYOUT = {
  name: "concentric",
  concentric: (n: cytoscape.NodeSingular): number => {
    const sz = Number(n.data("size") ?? 4);
    return sz;
  },
  levelWidth: () => 1,
  minNodeSpacing: 14,
  spacingFactor: 1.0,
  fit: true,
  padding: 30,
  animate: false,
  startAngle: (3 / 2) * Math.PI,
  // Skip halos/rings (they get repositioned to match their parent symbol below).
  boundingBox: undefined,
} as const;

/**
 * Background promotion to cose-bilkent. Animated end-state so the
 * user sees the constellation rearrange. numIter=1000, quality:'default'
 * — enough for visually correct clustering without runaway runtime.
 */
const COSE_LAYOUT = {
  name: "cose-bilkent",
  quality: "default",
  nodeRepulsion: 4500,
  idealEdgeLength: 60,
  edgeElasticity: 0.4,
  gravity: 0.25,
  numIter: 1000,
  animate: "end",
  animationDuration: 800,
  randomize: false,
  fit: false,
  padding: 30,
  tile: false,
  nodeDimensionsIncludeLabels: false,
} as const;

/** Wall-clock cap: if cose-bilkent doesn't fire `layoutready` by this many
 *  ms after we kick it off, bail and warn. Tuned so the browser never
 *  appears frozen — 4s is the sweet spot empirically (>1500 nodes can
 *  legitimately need ~3s on a slow machine). */
const COSE_TIMEOUT_MS = 4000;

export interface CyHandle {
  focus: (nodeId: string) => void;
  setKindFilter: (off: Set<string>) => void;
  setFocusDepth: (id: string | null, depth: number) => void;
  setSearch: (q: string) => void;
  firstMatch: (q: string) => NodePayload | null;
  fit: () => void;
  /** Underlying cytoscape Core. Returns null until the canvas has mounted. */
  getCy: () => Core | null;
}

interface Props {
  elements: ElementDefinition[];
  /** RCA sidecar — drives causal halos + recency rings. May be null. */
  rca: RcaSnapshot | null;
  onSelectNode: (data: NodePayload) => void;
  onHoverNode: (data: NodePayload | null) => void;
  /** Fires when cytoscape, the elements, or the layout settle. Overlays use
   * this to recompute centroids + label collision. */
  onReady?: (cy: Core) => void;
  /** Fires when the visible-node set changes (selection, filter, search) so
   * overlays can recompute their cached layout (centroids/labels). */
  onSelectionChange?: (selectedId: string | null) => void;
}

interface OverlayMaps {
  /** node-id (real) → halo node id */
  halo: Map<string, string>;
  /** node-id (real) → ring node id */
  ring: Map<string, string>;
}

function makeOverlays(
  cy: Core,
  rca: RcaSnapshot | null,
): OverlayMaps {
  const halo = new Map<string, string>();
  const ring = new Map<string, string>();
  if (!rca) return { halo, ring };

  // Build a lookup of real symbol nodes by (file, line) and by name.
  const byKey = new Map<string, NodeSingular>();
  cy.nodes().forEach((n) => {
    const d = n.data() as NodePayload;
    if (d.file !== null && d.line !== null) {
      byKey.set(`${d.file}#${d.line}`, n);
    }
  });

  // Halos from causalCandidates.
  for (const c of rca.causalCandidates) {
    if (c.file === null || c.line === null) continue;
    const target = byKey.get(`${c.file}#${c.line}`);
    if (!target) continue;
    const baseSize = Number(target.data("size") ?? 6);
    // Halo radius scales with score: small=2x base, top score ~5x base.
    const haloSize = Math.round(baseSize * (2 + 3 * Math.max(0, Math.min(1, c.score))));
    const haloId = `halo:${target.id()}`;
    cy.add({
      group: "nodes",
      data: {
        id: haloId,
        size: haloSize,
        color: haloColor(c.score),
        kind: "halo",
        name: "",
        label: "",
      },
      classes: "halo",
      position: target.position(),
      locked: false,
      selectable: false,
      grabbable: false,
    });
    halo.set(target.id(), haloId);
  }

  // Recency rings — from each candidate's recentChanges (the only place
  // we have day-bucketed recency on the wire).
  for (const c of rca.causalCandidates) {
    if (c.file === null || c.line === null) continue;
    if (!c.recentChanges || c.recentChanges.length === 0) continue;
    const target = byKey.get(`${c.file}#${c.line}`);
    if (!target) continue;
    const minDays = Math.min(...c.recentChanges.map((r) => r.daysAgo));
    let ringColor: string;
    let ringOpacity: number;
    if (minDays <= 7) {
      ringColor = RECENCY_COLORS.d7;
      ringOpacity = 0.85;
    } else if (minDays <= 30) {
      ringColor = RECENCY_COLORS.d30;
      ringOpacity = 0.7;
    } else if (minDays <= 90) {
      ringColor = RECENCY_COLORS.d90;
      ringOpacity = 0.55;
    } else {
      continue;
    }
    const baseSize = Number(target.data("size") ?? 6);
    const ringSize = baseSize + 4;
    const ringId = `ring:${target.id()}`;
    cy.add({
      group: "nodes",
      data: {
        id: ringId,
        size: ringSize,
        color: ringColor,
        ringColor,
        ringOpacity,
        kind: "ring",
        name: "",
        label: "",
      },
      classes: "ring",
      position: target.position(),
      locked: false,
      selectable: false,
      grabbable: false,
    });
    ring.set(target.id(), ringId);
  }

  return { halo, ring };
}

/** Re-pin halo + ring nodes to their parent symbol's current position. */
function syncOverlayPositions(cy: Core, overlays: OverlayMaps): void {
  cy.batch(() => {
    overlays.halo.forEach((haloId, parentId) => {
      const parent = cy.getElementById(parentId);
      const halo = cy.getElementById(haloId);
      if (!parent.empty() && !halo.empty()) {
        halo.position(parent.position());
      }
    });
    overlays.ring.forEach((ringId, parentId) => {
      const parent = cy.getElementById(parentId);
      const ring = cy.getElementById(ringId);
      if (!parent.empty() && !ring.empty()) {
        ring.position(parent.position());
      }
    });
  });
}

export const CyCanvas = forwardRef<CyHandle, Props>(function CyCanvas(props, ref) {
  registerOnce();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const overlaysRef = useRef<OverlayMaps>({ halo: new Map(), ring: new Map() });
  const onSelect = useRef(props.onSelectNode);
  const onHover = useRef(props.onHoverNode);
  const onReady = useRef(props.onReady);
  const onSelectionChange = useRef(props.onSelectionChange);
  onSelect.current = props.onSelectNode;
  onHover.current = props.onHoverNode;
  onReady.current = props.onReady;
  onSelectionChange.current = props.onSelectionChange;

  const elementsRef = useRef(props.elements);
  elementsRef.current = props.elements;
  const rcaRef = useRef(props.rca);
  rcaRef.current = props.rca;

  // Mount once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const cy = cytoscape({
      container,
      elements: elementsRef.current,
      style: STYLESHEET,
      // Apply concentric synchronously — fast first paint.
      layout: CONCENTRIC_LAYOUT,
      wheelSensitivity: 0.2,
      pixelRatio: 1.5,
      minZoom: 0.05,
      maxZoom: 3,
    });
    cyRef.current = cy;

    // Add halo + ring overlay nodes, then promote in background.
    overlaysRef.current = makeOverlays(cy, rcaRef.current);
    // Fire ready immediately for the concentric layout (overlays can render);
    // the cose-bilkent promotion will fire ready again when it settles.
    onReady.current?.(cy);
    schedulePromotion(cy, overlaysRef.current, () => onReady.current?.(cy));

    cy.on("tap", "node", (evt: EventObject) => {
      const n = evt.target as NodeSingular;
      // Halo / ring overlays are non-selectable; ignore taps on them.
      if (n.hasClass("halo") || n.hasClass("ring")) return;
      const data = n.data() as NodePayload;
      cy.nodes().removeClass("selected");
      n.addClass("selected");
      onSelect.current(data);
      onSelectionChange.current?.(n.id());
    });
    cy.on("tap", (evt: EventObject) => {
      if (evt.target === cy) {
        cy.nodes().removeClass("selected");
        onSelectionChange.current?.(null);
      }
    });
    cy.on("mouseover", "node", (evt: EventObject) => {
      const n = evt.target as NodeSingular;
      if (n.hasClass("halo") || n.hasClass("ring")) return;
      const neigh = n.closedNeighborhood();
      cy.batch(() => {
        cy.elements().removeClass("lit").removeClass("hovered");
        cy.nodes().difference(neigh.nodes()).addClass("dimmed");
        n.addClass("hovered");
        n.connectedEdges().addClass("lit");
      });
      onHover.current(n.data() as NodePayload);
    });
    cy.on("mouseout", "node", () => {
      cy.batch(() => {
        cy.elements().removeClass("dimmed").removeClass("lit").removeClass("hovered");
      });
      onHover.current(null);
    });

    // Keep overlay nodes pinned to their parent on every layout step
    // and on user drags (cytoscape uses `position` events for both).
    cy.on("position", "node", (evt: EventObject) => {
      const n = evt.target as NodeSingular;
      if (n.hasClass("halo") || n.hasClass("ring")) return;
      const id = n.id();
      const haloId = overlaysRef.current.halo.get(id);
      if (haloId) {
        const halo = cy.getElementById(haloId);
        if (!halo.empty()) halo.position(n.position());
      }
      const ringId = overlaysRef.current.ring.get(id);
      if (ringId) {
        const ring = cy.getElementById(ringId);
        if (!ring.empty()) ring.position(n.position());
      }
    });

    let lastW = container.clientWidth;
    let lastH = container.clientHeight;
    let scheduledFit = 0;
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) {
        lastW = w;
        lastH = h;
        return;
      }
      cy.resize();
      const grewFromZero = (lastW === 0 || lastH === 0) && w > 0 && h > 0;
      const bigJump = Math.abs(w - lastW) > 200 || Math.abs(h - lastH) > 200;
      if (grewFromZero || bigJump) {
        window.clearTimeout(scheduledFit);
        scheduledFit = window.setTimeout(() => cy.fit(undefined, 30), 80);
      }
      lastW = w;
      lastH = h;
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      window.clearTimeout(scheduledFit);
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-build elements + overlays when data changes. Same pipeline:
  // concentric synchronously, cose-bilkent in idle.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(props.elements);
    });
    cy.layout(CONCENTRIC_LAYOUT).run();
    overlaysRef.current = makeOverlays(cy, props.rca);
    syncOverlayPositions(cy, overlaysRef.current);
    onReady.current?.(cy);
    schedulePromotion(cy, overlaysRef.current, () => onReady.current?.(cy));
  }, [props.elements, props.rca]);

  useImperativeHandle(
    ref,
    (): CyHandle => ({
      focus: (nodeId: string) => {
        const cy = cyRef.current;
        if (!cy) return;
        const n = cy.getElementById(nodeId);
        if (n.empty()) return;
        cy.nodes().removeClass("selected");
        n.addClass("selected");
        cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1.0), duration: 350 });
      },
      setKindFilter: (off: Set<string>) => {
        const cy = cyRef.current;
        if (!cy) return;
        cy.batch(() => {
          cy.nodes().removeClass("hidden");
          if (off.size === 0) return;
          cy.nodes().forEach((n) => {
            if (n.hasClass("halo") || n.hasClass("ring")) return;
            const k = String(n.data("kind"));
            if (off.has(k)) n.addClass("hidden");
          });
        });
      },
      setFocusDepth: (id: string | null, depth: number) => {
        const cy = cyRef.current;
        if (!cy) return;
        cy.batch(() => {
          cy.elements().removeClass("hidden");
          if (id === null || depth < 0) return;
          const seed = cy.getElementById(id);
          if (seed.empty()) return;
          let visited: cytoscape.NodeCollection = cy.collection().union(seed.nodes());
          let frontier: cytoscape.NodeCollection = visited;
          for (let i = 0; i < depth; i++) {
            const next: cytoscape.NodeCollection = frontier.openNeighborhood().nodes();
            visited = visited.union(next);
            frontier = next;
          }
          const visibleEdges = visited.edgesWith(visited);
          const visible = visited.union(visibleEdges);
          cy.elements().difference(visible).addClass("hidden");
        });
      },
      setSearch: (q: string) => {
        const cy = cyRef.current;
        if (!cy) return;
        const lc = q.trim().toLowerCase();
        cy.batch(() => {
          cy.nodes().removeClass("searchmiss");
          if (lc === "") return;
          cy.nodes().forEach((n) => {
            if (n.hasClass("halo") || n.hasClass("ring")) return;
            const name = String(n.data("name") ?? "").toLowerCase();
            if (!name.includes(lc)) n.addClass("searchmiss");
          });
        });
      },
      firstMatch: (q: string) => {
        const cy = cyRef.current;
        if (!cy) return null;
        const lc = q.trim().toLowerCase();
        if (lc === "") return null;
        let found: NodePayload | null = null;
        cy.nodes().forEach((n) => {
          if (found) return;
          if (n.hasClass("halo") || n.hasClass("ring")) return;
          const name = String(n.data("name") ?? "").toLowerCase();
          if (name.includes(lc)) found = n.data() as NodePayload;
        });
        return found;
      },
      fit: () => {
        const cy = cyRef.current;
        if (!cy) return;
        cy.resize();
        cy.fit(undefined, 30);
      },
      getCy: () => cyRef.current,
    }),
    [],
  );

  return <div ref={containerRef} className="cy-host" />;
});

/** Defer cose-bilkent to idle; guard with a 4s wall-clock to prevent freeze. */
function schedulePromotion(
  cy: Core,
  overlays: OverlayMaps,
  onSettled?: () => void,
): void {
  const idle = (cb: () => void): number => {
    type RIC = (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number;
    const ric: RIC | undefined = (window as unknown as { requestIdleCallback?: RIC })
      .requestIdleCallback;
    if (typeof ric === "function") {
      return ric(() => cb(), { timeout: 200 });
    }
    return window.setTimeout(cb, 50);
  };

  idle(() => {
    if (cy.destroyed()) return;
    const start = performance.now();
    let finished = false;
    const layout = cy.layout(COSE_LAYOUT);

    const guard = window.setTimeout(() => {
      if (finished || cy.destroyed()) return;
      finished = true;
      // 4-second cap: kill the layout so the user keeps an interactive page.
      try {
        layout.stop();
      } catch {
        /* noop */
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[constellation] cose-bilkent exceeded ${COSE_TIMEOUT_MS}ms — keeping concentric layout.`,
      );
    }, COSE_TIMEOUT_MS);

    layout.one("layoutstop", () => {
      finished = true;
      window.clearTimeout(guard);
      const elapsed = Math.round(performance.now() - start);
      if (elapsed > COSE_TIMEOUT_MS) {
        // eslint-disable-next-line no-console
        console.warn(`[constellation] cose-bilkent took ${elapsed}ms (over budget).`);
      }
      if (!cy.destroyed()) {
        syncOverlayPositions(cy, overlays);
        cy.fit(undefined, 30);
        onSettled?.();
      }
    });

    layout.run();
  });
}
