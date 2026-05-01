import { create } from "zustand";
import { api } from "@/api/client.ts";

interface SelectionState {
  /** The session being viewed. */
  sessionId: string | null;
  /** The currently selected symbol (graph node). */
  selectedSymbol: { name: string; file: string | null; line: number | null } | null;
  /**
   * The last selection echoed *into* this client from the bridge WS — used
   * by the graph view to avoid re-publishing events it just received from
   * the bridge (which would otherwise feedback-loop).
   */
  lastBridgeRecv: { name: string; file: string; line: number } | null;
  /** Active top-level view. */
  view: "graph" | "rca" | "impact";
  /** Score threshold for the graph filter. */
  scoreThreshold: number;
  /** Subsystem filter (null = all). */
  subsystem: string | null;
  /** Recency window in days for the recency overlay. */
  recencyDays: number;

  setSessionId: (id: string | null) => void;
  selectSymbol: (s: SelectionState["selectedSymbol"]) => void;
  /** Apply a selection received from the bridge — does NOT re-publish. */
  applyBridgeSelection: (s: { name: string; file: string; line: number } | null) => void;
  setView: (v: SelectionState["view"]) => void;
  setScoreThreshold: (n: number) => void;
  setSubsystem: (s: string | null) => void;
  setRecencyDays: (n: number) => void;
}

export const useSession = create<SelectionState>((set) => ({
  sessionId: null,
  selectedSymbol: null,
  lastBridgeRecv: null,
  view: "graph",
  scoreThreshold: 0,
  subsystem: null,
  recencyDays: 90,
  setSessionId: (id) => set({ sessionId: id }),
  selectSymbol: (s) => {
    set({ selectedSymbol: s });
    // Best-effort publish to the bridge so MCP peers see our focus.
    if (s !== null && s.file !== null && s.line !== null) {
      void api.bridgePostSelect({ name: s.name, file: s.file, line: s.line });
    } else if (s === null) {
      void api.bridgePostSelect(null);
    }
  },
  applyBridgeSelection: (s) => {
    if (s === null) {
      set({ selectedSymbol: null, lastBridgeRecv: null });
      return;
    }
    set({
      selectedSymbol: { name: s.name, file: s.file, line: s.line },
      lastBridgeRecv: s,
    });
  },
  setView: (v) => set({ view: v }),
  setScoreThreshold: (n) => set({ scoreThreshold: n }),
  setSubsystem: (s) => set({ subsystem: s }),
  setRecencyDays: (n) => set({ recencyDays: n }),
}));
