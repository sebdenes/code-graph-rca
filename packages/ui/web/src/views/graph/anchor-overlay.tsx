/**
 * AnchorOverlay — renders a layered halo + 4-cross lens flare + 3 concentric
 * pulse rings centered on the anchor (selected node, or the RCA primary
 * symbol on first paint). Sits ABOVE the cytoscape canvas but with
 * pointer-events: none so clicks fall through to cy.
 *
 * We track the anchor's *rendered* position (post-pan/zoom screen-space) on
 * every cytoscape viewport tick, and update the overlay group's translate
 * via direct DOM mutation — no React renders on the hot path.
 */
import { memo, useEffect, useRef } from "react";
import type { Core } from "cytoscape";

interface Props {
  cy: Core | null;
  /** Cytoscape node id of the anchor symbol, or null to hide the overlay. */
  anchorId: string | null;
}

const FLARE_LEN = 100; // screen px

export const AnchorOverlay = memo(function AnchorOverlay({ cy, anchorId }: Props) {
  const groupRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    if (!cy || !anchorId) return;
    const node = cy.getElementById(anchorId);
    if (node.empty()) return;
    const group = groupRef.current;
    if (!group) return;

    const sync = () => {
      if (node.empty()) {
        group.setAttribute("transform", "translate(-9999 -9999)");
        return;
      }
      const p = node.renderedPosition();
      group.setAttribute("transform", `translate(${p.x} ${p.y})`);
    };
    sync();
    cy.on("viewport", sync);
    cy.on("layoutstop", sync);
    cy.on("position", `node[id = "${anchorId}"]`, sync);
    cy.on("resize", sync);
    return () => {
      cy.removeListener("viewport", sync);
      cy.removeListener("layoutstop", sync);
      cy.removeListener("position", sync);
      cy.removeListener("resize", sync);
    };
  }, [cy, anchorId]);

  if (!anchorId) return null;

  return (
    <svg
      className="anchor-overlay-svg"
      width="100%"
      height="100%"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 5,
      }}
    >
      <defs>
        <radialGradient id="halo-gradient-outer">
          <stop offset="0%" stopColor="rgba(255,92,106,0.55)" />
          <stop offset="40%" stopColor="rgba(255,92,106,0.22)" />
          <stop offset="80%" stopColor="rgba(255,92,106,0.05)" />
          <stop offset="100%" stopColor="rgba(255,92,106,0)" />
        </radialGradient>
        <radialGradient id="halo-gradient-inner">
          <stop offset="0%" stopColor="rgba(255,140,150,0.85)" />
          <stop offset="60%" stopColor="rgba(255,92,106,0.35)" />
          <stop offset="100%" stopColor="rgba(255,92,106,0)" />
        </radialGradient>
      </defs>
      <g ref={groupRef}>
        {/* Outer halo */}
        <circle r={110} className="anchor-halo-outer" fill="url(#halo-gradient-outer)" />
        {/* Inner halo */}
        <circle r={38} className="anchor-halo-inner" fill="url(#halo-gradient-inner)" />
        {/* 4-cross lens flare. Cardinals (0/90) get full opacity; diagonals fade. */}
        {[0, 45, 90, 135].map((deg) => {
          const rad = (deg * Math.PI) / 180;
          const dx = Math.cos(rad) * FLARE_LEN;
          const dy = Math.sin(rad) * FLARE_LEN;
          const cardinal = deg % 90 === 0;
          return (
            <line
              key={deg}
              x1={-dx}
              y1={-dy}
              x2={dx}
              y2={dy}
              className="anchor-flare"
              strokeWidth={cardinal ? 1.4 : 0.9}
              opacity={cardinal ? 0.7 : 0.4}
            />
          );
        })}
        {/* Concentric rings (3, fading outward). */}
        {([20, 30, 44] as const).map((r, i) => (
          <circle
            key={r}
            r={r}
            className={"anchor-ring" + (i >= 1 ? " outer" : "")}
            opacity={[0.55, 0.3, 0.15][i]}
          />
        ))}
      </g>
    </svg>
  );
});
