/**
 * 7-signal radial chart for a single causal candidate.
 *
 * Each signal becomes one ray from the center; ray length encodes the signal
 * score (clipped at the chart radius). Colors mirror the 7-signal palette
 * shown in the bottom legend bar of the Evidence Board, so the chart and
 * legend stay legible together.
 *
 * The 7 angles are evenly spaced (360 / 7 = ~51.4 deg apart) starting from
 * "north" at -90 deg. Ordering matches the legend left-to-right:
 *   recency · proximity · ambiguity · co-change · subsystem · complexity · data-flow
 */
import type { CausalCandidate } from "code-graph-rca";

export const SIGNAL_COLORS = {
  recency: "#ff8fc4",
  proximity: "#7aa8ff",
  ambiguity: "#c084fc",
  coChange: "#ffb547",
  subsystem: "#5dd699",
  complexity: "#5cd5ff",
  dataflow: "#5a5e74",
} as const;

export const SIGNAL_LABELS: Array<{
  key: keyof typeof SIGNAL_COLORS;
  short: string;
}> = [
  { key: "recency", short: "recency" },
  { key: "proximity", short: "proximity" },
  { key: "ambiguity", short: "ambiguity" },
  { key: "coChange", short: "co-change" },
  { key: "subsystem", short: "subsystem" },
  { key: "complexity", short: "complexity" },
  { key: "dataflow", short: "data-flow" },
];

interface Props {
  signals: CausalCandidate["signals"];
  /** Outer radius in viewBox units. Default 26 (matches 64×64 viewBox of -32..32). */
  radius?: number;
  /** When true, uses the halo-red center dot styling reserved for the anchor. */
  isAnchor?: boolean;
}

/**
 * Empirical max per-signal score from the scorer (`packages/core/src/rca/causal.ts`).
 * Recency caps at 3.0 (recent week peak), proximity at 2.5 (d=1), etc. We
 * normalize each ray against its own ceiling so signals stay comparable
 * even though their raw ranges differ.
 */
const SIGNAL_MAX: Record<keyof typeof SIGNAL_COLORS, number> = {
  recency: 3.0,
  proximity: 2.5,
  ambiguity: 1.5,
  coChange: 3.0,
  subsystem: 0.5,
  complexity: 1.5,
  dataflow: 1.5,
};

function rayEnd(
  angleDeg: number,
  length: number,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: Math.cos(rad) * length,
    y: Math.sin(rad) * length,
  };
}

export function SignalRadial({ signals, radius = 26, isAnchor = false }: Props) {
  // Map each signal score to a ray length, clipped to [0, radius].
  const rays = SIGNAL_LABELS.map((sig, i) => {
    const raw = (signals as unknown as Record<string, number>)[`${sig.key}Score`] ?? 0;
    const max = SIGNAL_MAX[sig.key];
    const norm = max > 0 ? Math.max(0, Math.min(1, raw / max)) : 0;
    // Always render a tiny stub (3 units) so even zero-score signals leave a
    // dim mark at the right angle — keeps the radial visually balanced.
    const length = Math.max(2, norm * radius);
    // Start at -90deg (north) and walk clockwise.
    const angle = -90 + (360 / SIGNAL_LABELS.length) * i;
    const end = rayEnd(angle, length);
    return { sig, end, length };
  });

  return (
    <svg
      className="rca-signal-radial"
      viewBox="-32 -32 64 64"
      role="img"
      aria-label="7-signal radial"
    >
      <g strokeWidth={1.5} strokeLinecap="round">
        {rays.map(({ sig, end }) => (
          <line
            key={sig.key}
            x1={0}
            y1={0}
            x2={end.x.toFixed(2)}
            y2={end.y.toFixed(2)}
            stroke={SIGNAL_COLORS[sig.key]}
          />
        ))}
      </g>
      {isAnchor ? (
        <>
          <circle r={2} fill="#ff5c6a" />
          <circle r={6} fill="none" stroke="#ff5c6a" strokeOpacity={0.5} strokeWidth={0.8} />
        </>
      ) : (
        <circle r={1.6} fill="#7aa8ff" />
      )}
    </svg>
  );
}
