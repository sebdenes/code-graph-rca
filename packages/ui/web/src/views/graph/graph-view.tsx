/**
 * Constellation Graph view shell.
 *
 * Layout: a 3-column CSS grid — `[ rail | inspector | canvas ]`. The rail
 * is 60px collapsed / 200px hovered (handled inside the Explorer with a
 * width transition). The inspector takes 380px when at least one tab is
 * pinned; otherwise it collapses to 0 and the canvas fills the freed space.
 *
 * Top bar is intentionally quiet: just the centered search and a tiny
 * `N · M` stat readout. No project name, no branch badge, no kind chips,
 * no budget chips — those moved into the rail.
 *
 * Bottom-right of the canvas is a small permanent stat: `nodes · edges ·
 * scope`, monospaced, faint. Reads like an instrument panel.
 *
 * Selection / pinning behavior is unchanged from the previous version: a
 * tap on a graph node updates the global session store (so RCA / Impact
 * pick it up) AND adds the node's owning file to the pinned-tabs LRU, with
 * cap = 6.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/state/session.ts";
import { useGraphData } from "./use-graph-data.ts";
import { CyCanvas, type CyHandle } from "./cy-canvas.tsx";
import { Explorer } from "./explorer.tsx";
import { Inspector, type PinnedFile } from "./inspector.tsx";
import type { NodePayload } from "./build-elements.ts";
import type { NodeKind } from "./styles.ts";
import "./graph.css";

const MAX_PINS = 6;

export function GraphView({ sessionId }: { sessionId: string }) {
  const selectSymbol = useSession((s) => s.selectSymbol);
  const cyRef = useRef<CyHandle | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const [maxSymbols, setMaxSymbols] = useState<number>(400);
  const [hiddenKinds, setHiddenKinds] = useState<Set<NodeKind>>(new Set());
  const [focusDepth, setFocusDepth] = useState<number>(-1);
  const [search, setSearch] = useState("");
  const [pins, setPins] = useState<PinnedFile[]>([]);
  const [selectedNode, setSelectedNode] = useState<NodePayload | null>(null);

  const { query, data } = useGraphData({ sessionId, maxSymbols });

  const onSelectNode = useCallback(
    (n: NodePayload) => {
      setSelectedNode(n);
      // Mirror selection into the global session store so the RCA / Impact
      // views pick it up when the user navigates.
      if (n.symbolId !== null) {
        selectSymbol({ name: n.name, file: n.file, line: n.line });
      }
      const filePath = n.file;
      if (filePath === null) return;
      setPins((prev) => {
        const idForPin = n.id;
        const existingIdx = prev.findIndex((p) => p.path === filePath);
        if (existingIdx !== -1) {
          const updated: PinnedFile = {
            ...prev[existingIdx]!,
            line: n.line,
            highlightRange:
              n.line !== null ? { start: n.line, end: n.line } : null,
            kind: n.kind as NodeKind,
            id: idForPin,
            symbolName: n.name,
          };
          const next = prev.filter((_, i) => i !== existingIdx);
          next.push(updated);
          return next;
        }
        const newPin: PinnedFile = {
          id: idForPin,
          path: filePath,
          line: n.line,
          highlightRange:
            n.line !== null ? { start: n.line, end: n.line } : null,
          kind: n.kind as NodeKind,
          symbolName: n.name,
        };
        const next = [...prev, newPin];
        if (next.length > MAX_PINS) next.shift();
        return next;
      });
    },
    [selectSymbol],
  );

  const onHoverNode = useCallback((_n: NodePayload | null) => {
    // Hover styling is applied inside CyCanvas via cytoscape classes.
  }, []);

  const onClosePin = useCallback((id: string) => {
    setPins((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const onToggleKind = useCallback((k: NodeKind) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  useEffect(() => {
    cyRef.current?.setKindFilter(hiddenKinds as Set<string>);
  }, [hiddenKinds, data]);

  useEffect(() => {
    const id = selectedNode?.id ?? null;
    cyRef.current?.setFocusDepth(id, focusDepth);
  }, [focusDepth, selectedNode, data]);

  useEffect(() => {
    cyRef.current?.setSearch(search);
  }, [search, data]);

  const onSearchSubmit = useCallback(() => {
    if (!cyRef.current) return;
    const match = cyRef.current.firstMatch(search);
    if (match) {
      cyRef.current.focus(match.id);
      onSelectNode(match);
    }
  }, [search, onSelectNode]);

  const onResetView = useCallback(() => {
    setSelectedNode(null);
    setFocusDepth(-1);
    setSearch("");
    setHiddenKinds(new Set());
    cyRef.current?.fit();
  }, []);

  // Cmd/Ctrl + K focuses the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const accel = isMac ? e.metaKey : e.ctrlKey;
      if (accel && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (query.isError) {
    const msg = query.error instanceof Error ? query.error.message : String(query.error);
    return (
      <div className="graph-shell flex h-full w-full">
        <div className="m-auto rounded border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          Failed to load graph: {msg}
        </div>
      </div>
    );
  }

  if (query.isPending || !data) {
    return (
      <div className="graph-shell flex h-full w-full items-center justify-center text-zinc-500">
        Indexing graph…
      </div>
    );
  }

  if (data.symbolCount === 0) {
    return (
      <div className="graph-shell flex h-full w-full items-center justify-center text-zinc-500">
        This session has no indexed symbols.
      </div>
    );
  }

  const inspectorWidth = pins.length === 0 ? 0 : 380;
  const nodeCount = data.symbolCount + data.fileCount;

  return (
    <div className="graph-shell starfield flex h-full w-full flex-col">
      <TopBar
        searchRef={searchRef}
        nodeCount={nodeCount}
        edgeCount={data.edgeCount}
        search={search}
        onSearch={setSearch}
        onSubmit={onSearchSubmit}
      />
      <div
        className="grid min-h-0 w-full flex-1"
        style={{ gridTemplateColumns: `60px ${inspectorWidth}px 1fr` }}
      >
        <Explorer
          hiddenKinds={hiddenKinds}
          onToggleKind={onToggleKind}
          focusDepth={focusDepth}
          onSetFocusDepth={setFocusDepth}
          selectedNodeName={selectedNode?.name ?? null}
          onResetView={onResetView}
          maxSymbols={maxSymbols}
          onSetMaxSymbols={setMaxSymbols}
        />
        {inspectorWidth > 0 ? (
          <Inspector sessionId={sessionId} pins={pins} onClose={onClosePin} />
        ) : (
          <div />
        )}
        <div className="canvas-region relative overflow-hidden">
          <CyCanvas
            ref={cyRef}
            elements={data.elements}
            rca={data.rca}
            onSelectNode={onSelectNode}
            onHoverNode={onHoverNode}
          />
          <div className="instrument-readout pointer-events-none absolute bottom-2 right-3 select-none font-mono text-[10px] text-zinc-500/80">
            nodes {nodeCount} · edges {data.edgeCount} · scope {maxSymbols}
            {data.truncated ? <span className="ml-2 text-amber-300/80">truncated</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

interface TopBarProps {
  nodeCount: number;
  edgeCount: number;
  search: string;
  onSearch: (s: string) => void;
  onSubmit: () => void;
  searchRef: React.RefObject<HTMLInputElement>;
}

function TopBar(props: TopBarProps) {
  const { nodeCount, edgeCount, search, onSearch, onSubmit, searchRef } = props;
  return (
    <header className="constellation-topbar flex shrink-0 items-center gap-3 px-4 py-2 text-sm">
      <div className="mx-auto flex items-center gap-2">
        <input
          ref={searchRef}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          placeholder="Search symbols…"
          className="constellation-search w-[360px] max-w-[40vw] rounded-md px-3 py-1.5 text-[12px] placeholder:text-zinc-500"
        />
        <span className="rounded border border-zinc-700/60 bg-[#0c1224] px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
          ⌘K
        </span>
      </div>
      <div className="ml-auto font-mono text-[11px] text-zinc-500">
        {nodeCount} · {edgeCount}
      </div>
    </header>
  );
}
