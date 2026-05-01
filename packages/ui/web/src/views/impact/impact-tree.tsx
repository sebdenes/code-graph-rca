import { useState } from "react";
import type { ImpactNode } from "@shared/api";
import { cn, scoreColor } from "../../lib/utils.ts";

interface Props {
  root: ImpactNode;
  selectedKey: string | null;
  onSelect: (node: ImpactNode) => void;
}

export function ImpactTree({ root, selectedKey, onSelect }: Props) {
  return (
    <div className="font-mono text-xs">
      <TreeRow node={root} depth={0} selectedKey={selectedKey} onSelect={onSelect} />
    </div>
  );
}

interface RowProps {
  node: ImpactNode;
  depth: number;
  selectedKey: string | null;
  onSelect: (node: ImpactNode) => void;
}

function nodeKey(n: ImpactNode): string {
  return `${n.name}@${n.file}:${n.line}`;
}

function TreeRow({ node, depth, selectedKey, onSelect }: RowProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.callers.length > 0;
  const key = nodeKey(node);
  const isSelected = selectedKey === key;
  const risk = scoreColor(node.riskScore * 10);
  const tested = node.testCoverage.length > 0;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 px-2 py-1 hover:bg-muted/60",
          isSelected && "bg-accent/40",
        )}
      >
        {Array.from({ length: depth }).map((_, i) => (
          <span key={i} className="inline-block w-3 border-l border-border/60" aria-hidden />
        ))}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            "inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground",
            !hasChildren && "invisible",
          )}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <button
          type="button"
          onClick={() => onSelect(node)}
          className="flex flex-1 items-center gap-2 truncate text-left"
        >
          <span className="truncate text-foreground">{node.name}</span>
          <span className="truncate text-muted-foreground">
            {node.file}:{node.line}
          </span>
          <span
            className="ml-auto inline-flex h-5 min-w-10 items-center justify-center rounded px-1 text-[10px] font-semibold text-background"
            style={{ backgroundColor: risk }}
            title={`risk ${node.riskScore.toFixed(2)}`}
          >
            {node.riskScore.toFixed(2)}
          </span>
          <span
            className={cn(
              "inline-flex h-5 min-w-6 items-center justify-center rounded px-1 text-[10px] font-semibold",
              tested
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-red-500/20 text-red-400",
            )}
            title={tested ? `${node.testCoverage.length} test(s)` : "no tests"}
          >
            {tested ? "✓" : "✗"}
          </span>
          {node.recentChanges.length > 0 && (
            <span
              className="inline-flex h-5 min-w-6 items-center justify-center rounded bg-amber-500/20 px-1 text-[10px] font-semibold text-amber-400"
              title={`${node.recentChanges.length} recent change(s)`}
            >
              Δ{node.recentChanges.length}
            </span>
          )}
        </button>
      </div>
      {expanded &&
        hasChildren &&
        node.callers.map((c, i) => (
          <TreeRow
            key={`${nodeKey(c)}#${i}`}
            node={c}
            depth={depth + 1}
            selectedKey={selectedKey}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

export { nodeKey };
