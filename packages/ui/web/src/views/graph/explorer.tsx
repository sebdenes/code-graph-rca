/**
 * Constellation Explorer — slim instrument-panel rail.
 *
 * Default state is a 60px-wide column of vertically stacked color dots,
 * one per node kind. Hover the rail and it expands to ~200px showing kind
 * names. Click a dot to toggle visibility for that kind.
 *
 * The rail's footer carries:
 *   - a tiny "reset" icon button
 *   - a ⚙ button that opens a popover with budget choices.
 *
 * No focus-depth chips, no project name, no per-kind text in the default
 * state — those decorations were removed in the redesign. Focus depth and
 * status readouts moved into the canvas chrome (graph-view.tsx).
 */
import { useState } from "react";
import { cn } from "@/lib/utils.ts";
import { KIND_COLORS, type NodeKind } from "./styles.ts";

const RAIL_KINDS: NodeKind[] = [
  "folder",
  "file",
  "class",
  "function",
  "method",
  "interface",
  "const",
  "enum",
  "type",
  "phantom",
];

const RAIL_LABEL: Record<NodeKind, string> = {
  folder: "folder",
  file: "file",
  class: "class",
  function: "function",
  method: "method",
  interface: "interface",
  const: "const",
  enum: "enum",
  type: "type",
  phantom: "unresolved",
};

const BUDGETS = [400, 800, 1500, 2500, 5000] as const;

const FOCUS_DEPTHS: Array<{ label: string; value: number }> = [
  { label: "1", value: 1 },
  { label: "2", value: 2 },
  { label: "3", value: 3 },
  { label: "5", value: 5 },
  { label: "All", value: -1 },
];

export interface ExplorerProps {
  hiddenKinds: Set<NodeKind>;
  onToggleKind: (k: NodeKind) => void;
  focusDepth: number;
  onSetFocusDepth: (n: number) => void;
  selectedNodeName: string | null;
  onResetView: () => void;
  maxSymbols: number;
  onSetMaxSymbols: (n: number) => void;
}

export function Explorer(props: ExplorerProps) {
  const {
    hiddenKinds,
    onToggleKind,
    focusDepth,
    onSetFocusDepth,
    selectedNodeName,
    onResetView,
    maxSymbols,
    onSetMaxSymbols,
  } = props;
  const [hovered, setHovered] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);

  return (
    <aside
      className={cn(
        "constellation-rail relative flex h-full flex-col py-3 transition-[width] duration-150 ease-out",
        hovered ? "w-[200px]" : "w-[60px]",
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setBudgetOpen(false);
      }}
    >
      <div className="rail-section flex flex-col gap-0.5 px-2">
        {RAIL_KINDS.map((k) => {
          const off = hiddenKinds.has(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => onToggleKind(k)}
              className={cn(
                "rail-kind flex items-center gap-3 rounded px-2 py-1 transition",
                off ? "opacity-40 hover:opacity-70" : "opacity-100",
              )}
              title={off ? `Show ${k}` : `Hide ${k}`}
            >
              <span
                className="kind-dot shrink-0"
                style={{ background: KIND_COLORS[k] }}
                aria-hidden
              />
              {hovered ? (
                <span className="font-mono text-[11px] text-zinc-300">
                  {RAIL_LABEL[k]}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {hovered && selectedNodeName !== null ? (
        <div className="rail-section mt-3 px-3">
          <div className="mb-1 text-[9px] uppercase tracking-wider text-zinc-500">
            Focus depth
          </div>
          <div className="flex flex-wrap gap-1">
            {FOCUS_DEPTHS.map((d) => {
              const active = focusDepth === d.value;
              return (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => onSetFocusDepth(d.value)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 font-mono text-[9px] transition",
                    active
                      ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-200"
                      : "border-zinc-700/60 bg-transparent text-zinc-400 hover:text-zinc-200",
                  )}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-auto flex flex-col gap-1 px-2">
        <button
          type="button"
          onClick={onResetView}
          className="rail-icon flex items-center gap-3 rounded px-2 py-1 text-zinc-500 transition hover:text-zinc-200"
          title="Reset view"
        >
          <ResetIcon />
          {hovered ? <span className="font-mono text-[11px]">reset</span> : null}
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setBudgetOpen((v) => !v)}
            className="rail-icon flex w-full items-center gap-3 rounded px-2 py-1 text-zinc-500 transition hover:text-zinc-200"
            title="Symbol budget"
          >
            <CogIcon />
            {hovered ? (
              <span className="font-mono text-[11px]">
                budget · {maxSymbols}
              </span>
            ) : null}
          </button>
          {budgetOpen ? (
            <div className="rail-popover absolute bottom-full left-2 mb-1 flex flex-col gap-0.5 rounded border border-zinc-700/70 bg-[#0c1224] p-1 shadow-lg">
              {BUDGETS.map((n) => {
                const active = maxSymbols === n;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      onSetMaxSymbols(n);
                      setBudgetOpen(false);
                    }}
                    className={cn(
                      "rounded px-2 py-0.5 text-left font-mono text-[10px] transition",
                      active
                        ? "bg-cyan-500/15 text-cyan-200"
                        : "text-zinc-300 hover:bg-zinc-800/60",
                    )}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function ResetIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

function CogIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
