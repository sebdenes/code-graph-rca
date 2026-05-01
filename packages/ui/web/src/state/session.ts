import { create } from "zustand";

interface SelectionState {
  /** The session being viewed. */
  sessionId: string | null;
  /** The currently selected symbol (graph node). */
  selectedSymbol: { name: string; file: string | null; line: number | null } | null;
  /** Active top-level view. */
  view: "rca" | "impact";
  /** Score threshold for the graph filter. */
  scoreThreshold: number;
  /** Subsystem filter (null = all). */
  subsystem: string | null;
  /** Recency window in days for the recency overlay. */
  recencyDays: number;

  setSessionId: (id: string | null) => void;
  selectSymbol: (s: SelectionState["selectedSymbol"]) => void;
  setView: (v: SelectionState["view"]) => void;
  setScoreThreshold: (n: number) => void;
  setSubsystem: (s: string | null) => void;
  setRecencyDays: (n: number) => void;
}

export const useSession = create<SelectionState>((set) => ({
  sessionId: null,
  selectedSymbol: null,
  view: "rca",
  scoreThreshold: 0,
  subsystem: null,
  recencyDays: 90,
  setSessionId: (id) => set({ sessionId: id }),
  selectSymbol: (s) => set({ selectedSymbol: s }),
  setView: (v) => set({ view: v }),
  setScoreThreshold: (n) => set({ scoreThreshold: n }),
  setSubsystem: (s) => set({ subsystem: s }),
  setRecencyDays: (n) => set({ recencyDays: n }),
}));
