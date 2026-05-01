import { useMemo, useState } from "react";
import type { ImpactNode } from "@shared/api";
import { cn, scoreColor } from "../../lib/utils.ts";
import { nodeKey } from "./impact-tree.tsx";

type SortKey = "name" | "risk" | "depth";
type SortDir = "asc" | "desc";

interface Props {
  nodes: ImpactNode[];
  selectedKey: string | null;
  onSelect: (node: ImpactNode) => void;
}

export function ImpactTable({ nodes, selectedKey, onSelect }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("risk");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    const copy = nodes.slice();
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "risk") cmp = a.riskScore - b.riskScore;
      else cmp = a.distance - b.distance;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [nodes, sortKey, sortDir]);

  function toggle(k: SortKey) {
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir(k === "name" ? "asc" : "desc");
    }
  }

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        <HeaderButton label="Name" active={sortKey === "name"} dir={sortDir} onClick={() => toggle("name")} className="flex-1" />
        <HeaderButton label="Depth" active={sortKey === "depth"} dir={sortDir} onClick={() => toggle("depth")} className="w-12 text-right" />
        <HeaderButton label="Risk" active={sortKey === "risk"} dir={sortDir} onClick={() => toggle("risk")} className="w-14 text-right" />
        <span className="w-8 text-right">Test</span>
        <span className="w-8 text-right">Δ</span>
      </div>
      <div className="flex-1 overflow-auto">
        {sorted.map((n, i) => {
          const k = nodeKey(n);
          const isSelected = selectedKey === k;
          const tested = n.testCoverage.length > 0;
          return (
            <button
              key={`${k}#${i}`}
              type="button"
              onClick={() => onSelect(n)}
              className={cn(
                "flex w-full items-center gap-2 border-b border-border/40 px-2 py-1 text-left font-mono hover:bg-muted/60",
                isSelected && "bg-accent/40",
              )}
            >
              <span className="flex-1 truncate">
                <span className="text-foreground">{n.name}</span>{" "}
                <span className="text-muted-foreground">
                  {n.file}:{n.line}
                </span>
              </span>
              <span className="w-12 text-right text-muted-foreground">{n.distance}</span>
              <span
                className="inline-flex h-5 w-14 items-center justify-center rounded text-[10px] font-semibold text-background"
                style={{ backgroundColor: scoreColor(n.riskScore * 10) }}
              >
                {n.riskScore.toFixed(2)}
              </span>
              <span
                className={cn(
                  "inline-flex h-5 w-8 items-center justify-center rounded text-[10px] font-semibold",
                  tested ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400",
                )}
              >
                {tested ? "✓" : "✗"}
              </span>
              <span className="w-8 text-right text-muted-foreground">{n.recentChanges.length}</span>
            </button>
          );
        })}
        {sorted.length === 0 && (
          <div className="px-2 py-2 text-muted-foreground">No affected nodes.</div>
        )}
      </div>
    </div>
  );
}

function HeaderButton({
  label,
  active,
  dir,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("text-left hover:text-foreground", active && "text-foreground", className)}
    >
      {label}
      {active ? (dir === "asc" ? " ▲" : " ▼") : ""}
    </button>
  );
}
