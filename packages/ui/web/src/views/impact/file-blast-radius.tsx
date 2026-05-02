/**
 * FileBlastRadius — top-right summary panel: one row per file in the impact
 * set, sorted by max risk (hot files first). Computes file-level rollups
 * directly from the flat `nodes` array — see `computeFileRollups` for the
 * exact aggregation. Click a row to focus the first symbol in that file.
 */
import { useMemo } from "react";
import type { ImpactNode } from "@shared/api";

interface Props {
  nodes: ImpactNode[];
  onFocus?: (firstNodeInFile: ImpactNode) => void;
  /** Cap to keep the panel readable. */
  maxRows?: number;
}

interface FileRollup {
  file: string;
  basename: string;
  count: number;
  maxRisk: number;
  /** First (highest-risk) node in this file — used as the click target. */
  hottest: ImpactNode;
}

export function computeFileRollups(nodes: ImpactNode[]): FileRollup[] {
  const map = new Map<string, FileRollup>();
  for (const n of nodes) {
    const cur = map.get(n.file);
    if (!cur) {
      map.set(n.file, {
        file: n.file,
        basename: basenameOf(n.file),
        count: 1,
        maxRisk: n.riskScore,
        hottest: n,
      });
    } else {
      cur.count += 1;
      if (n.riskScore > cur.maxRisk) {
        cur.maxRisk = n.riskScore;
        cur.hottest = n;
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.maxRisk - a.maxRisk);
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function riskClass(r: number): "hot" | "warn" | "cool" {
  if (r >= 0.75) return "hot";
  if (r >= 0.5) return "warn";
  return "cool";
}

export function FileBlastRadius({ nodes, onFocus, maxRows = 8 }: Props) {
  const rollups = useMemo(() => computeFileRollups(nodes), [nodes]);
  const shown = rollups.slice(0, maxRows);
  return (
    <div className="file-blast-radius">
      <div className="head">Files in blast radius · {rollups.length}</div>
      {shown.map((r) => (
        <button
          key={r.file}
          type="button"
          className="file-row"
          title={r.file}
          onClick={() => onFocus?.(r.hottest)}
        >
          <span className="name">{r.basename}</span>
          <span className="count">{r.count} sym</span>
          <span className={`max ${riskClass(r.maxRisk)}`}>{r.maxRisk.toFixed(2)}</span>
        </button>
      ))}
    </div>
  );
}
