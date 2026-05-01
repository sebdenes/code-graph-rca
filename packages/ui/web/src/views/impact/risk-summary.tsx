import { scoreColor } from "../../lib/utils.ts";

interface Props {
  maxRisk: number;
}

export function RiskSummary({ maxRisk }: Props) {
  const message =
    maxRisk >= 0.7
      ? "High blast radius — review carefully before changing."
      : maxRisk >= 0.4
        ? "Moderate impact — at least one untested or recently-changed caller."
        : "Low impact — most callers look stable.";
  const color = scoreColor(maxRisk * 10);
  return (
    <div className="flex items-center gap-3 rounded border border-border bg-muted/40 px-3 py-2 text-sm">
      <span
        className="inline-flex h-7 min-w-12 items-center justify-center rounded px-2 font-mono text-xs font-semibold text-background"
        style={{ backgroundColor: color }}
      >
        {maxRisk.toFixed(2)}
      </span>
      <span className="text-foreground">{message}</span>
    </div>
  );
}
