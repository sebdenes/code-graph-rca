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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Core } from "cytoscape";
import { useSession } from "@/state/session.ts";
import { useGraphData } from "./use-graph-data.ts";
import { CyCanvas, type CyHandle } from "./cy-canvas.tsx";
import { Explorer } from "./explorer.tsx";
import { Inspector, type PinnedFile } from "./inspector.tsx";
import type { NodePayload } from "./build-elements.ts";
import type { NodeKind } from "./styles.ts";
import { NebulaLayer, computeFileClusters, type FileCluster } from "./nebula-layer.tsx";
import { AnchorOverlay } from "./anchor-overlay.tsx";
import { SmartLabels } from "./smart-labels.tsx";
import type { RcaSnapshot } from "@shared/api";
import "./graph.css";
import "./observatory.css";

const MAX_PINS = 6;

export function GraphView({ sessionId }: { sessionId: string }) {
  const selectSymbol = useSession((s) => s.selectSymbol);
  const applyBridgeSelection = useSession((s) => s.applyBridgeSelection);
  const cyRef = useRef<CyHandle | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const [maxSymbols, setMaxSymbols] = useState<number>(400);
  const [hiddenKinds, setHiddenKinds] = useState<Set<NodeKind>>(new Set());
  const [focusDepth, setFocusDepth] = useState<number>(-1);
  const [search, setSearch] = useState("");
  const [pins, setPins] = useState<PinnedFile[]>([]);
  const [selectedNode, setSelectedNode] = useState<NodePayload | null>(null);

  // Observatory overlays — recomputed on layout settle / selection change.
  const [cy, setCy] = useState<Core | null>(null);
  const [clusters, setClusters] = useState<FileCluster[]>([]);
  const [layoutVersion, setLayoutVersion] = useState(0);

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

  const onCyReady = useCallback((core: Core) => {
    setCy(core);
    setClusters(computeFileClusters(core));
    setLayoutVersion((v) => v + 1);
  }, []);

  // Cytoscape id of the active anchor — the selected node, falling back to
  // the RCA primary symbol on first paint. Recomputed when selection or RCA
  // changes; safe to call before cy mounts (returns null in that case).
  const anchorId = useMemo<string | null>(() => {
    if (!cy) return null;
    if (selectedNode) return selectedNode.id;
    return findPrimaryAnchorId(cy, data?.rca ?? null);
  }, [cy, selectedNode, data?.rca, layoutVersion]);

  const anchorFile = useMemo<string | null>(() => {
    if (!anchorId || !cy) return null;
    const n = cy.getElementById(anchorId);
    if (n.empty()) return null;
    const f = n.data("file");
    return typeof f === "string" ? f : null;
  }, [cy, anchorId, layoutVersion]);

  // Toggle the `.lit` class on edges incident to the anchor whenever it
  // changes. Hover-driven `.lit` is already handled inside CyCanvas; this
  // keeps the anchor highlighted persistently when nothing is hovered.
  useEffect(() => {
    if (!cy) return;
    cy.batch(() => {
      cy.edges().removeClass("anchor-lit");
      if (anchorId) {
        const node = cy.getElementById(anchorId);
        if (!node.empty()) {
          node.connectedEdges().addClass("anchor-lit").addClass("lit");
        }
      }
    });
  }, [cy, anchorId, layoutVersion]);

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

  // Bridge mode: subscribe to selection updates from MCP peers.
  // Skip events whose payload matches the most recent local selection so we
  // don't re-apply our own POST as a remote update.
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/bridge/live`;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    const onMessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
          kind?: string;
          payload?: { name: string; file: string; line: number } | null;
        };
        if (msg.kind !== "select") return;
        const local = useSession.getState().selectedSymbol;
        const payload = msg.payload ?? null;
        if (
          payload &&
          local &&
          local.name === payload.name &&
          local.file === payload.file &&
          local.line === payload.line
        ) {
          return; // echo of our own POST
        }
        applyBridgeSelection(payload);
      } catch {
        // ignore malformed frames
      }
    };
    ws.addEventListener("message", onMessage);
    return () => {
      try {
        ws?.removeEventListener("message", onMessage);
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, [applyBridgeSelection]);

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
    <div className="graph-shell starfield observatory-stage flex h-full w-full flex-col">
      <TopBar
        searchRef={searchRef}
        nodeCount={nodeCount}
        edgeCount={data.edgeCount}
        fileCount={data.fileCount}
        symbolCount={data.symbolCount}
        sessionId={sessionId}
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
          {/* Order matters: nebula (z 0) → cy canvas (z 1) → anchor flare
            * (z 5) → smart labels (z 6) → caption / legend (z 8). */}
          <NebulaLayer cy={cy} clusters={clusters} anchorFile={anchorFile} />
          <CyCanvas
            ref={cyRef}
            elements={data.elements}
            rca={data.rca}
            onSelectNode={onSelectNode}
            onHoverNode={onHoverNode}
            onReady={onCyReady}
          />
          <AnchorOverlay cy={cy} anchorId={anchorId} />
          <SmartLabels cy={cy} layoutVersion={layoutVersion} anchorId={anchorId} />
          <HypothesisCaption rca={data.rca} anchorName={anchorNameFor(cy, anchorId)} />
          <ObservatoryLegend />
          <div className="instrument-readout pointer-events-none absolute bottom-2 right-3 select-none font-mono text-[10px] text-zinc-500/80">
            nodes {nodeCount} · edges {data.edgeCount} · scope {maxSymbols}
            {data.truncated ? <span className="ml-2 text-amber-300/80">truncated</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Find the cytoscape node id of the RCA primary symbol. Returns null when
 *  there's no RCA, or when the named symbol isn't in the rendered graph. */
function findPrimaryAnchorId(cy: Core, rca: RcaSnapshot | null): string | null {
  if (!rca) return null;
  const primary = rca.primarySymbol;
  if (!primary) return null;
  // Prefer the first causalCandidate with role "anchor" (it has file+line),
  // then fall back to a name match.
  const anchorCand = rca.causalCandidates.find((c) => c.role === "anchor");
  if (anchorCand && anchorCand.file !== null && anchorCand.line !== null) {
    let found: string | null = null;
    cy.nodes().forEach((n) => {
      if (found) return;
      if (n.hasClass("halo") || n.hasClass("ring")) return;
      const f = n.data("file");
      const l = n.data("line");
      const name = String(n.data("name") ?? "");
      if (f === anchorCand.file && l === anchorCand.line && name === anchorCand.name) {
        found = n.id();
      }
    });
    if (found) return found;
  }
  let byName: string | null = null;
  cy.nodes().forEach((n) => {
    if (byName) return;
    if (n.hasClass("halo") || n.hasClass("ring")) return;
    if (String(n.data("name") ?? "") === primary) byName = n.id();
  });
  return byName;
}

function anchorNameFor(cy: Core | null, anchorId: string | null): string | null {
  if (!cy || !anchorId) return null;
  const n = cy.getElementById(anchorId);
  if (n.empty()) return null;
  const name = n.data("name");
  return typeof name === "string" ? name : null;
}

interface HypothesisCaptionProps {
  rca: RcaSnapshot | null;
  anchorName: string | null;
}

function HypothesisCaption({ rca, anchorName }: HypothesisCaptionProps) {
  if (!rca) return null;
  const name = anchorName ?? rca.primarySymbol;
  if (!name) return null;
  // Pull a 2-sentence summary from firstHypothesis or the top causal candidate.
  const sentences: string[] = [];
  const fh = rca.firstHypothesis ?? "";
  if (fh) {
    const split = fh.replace(/\s+/g, " ").trim().split(/(?<=\.)\s+/);
    for (const s of split) {
      if (sentences.length >= 2) break;
      if (s.length > 0) sentences.push(s);
    }
  }
  if (sentences.length === 0) {
    const top = rca.causalCandidates[0];
    if (top) {
      sentences.push(top.rationale);
    }
  }
  if (sentences.length === 0) return null;
  return (
    <div className="observatory-hypothesis">
      The most likely cause sits in <span className="anchor-name">{name}</span>.{" "}
      {sentences.slice(0, 2).join(" ")}
    </div>
  );
}

function ObservatoryLegend() {
  return (
    <div className="observatory-legend">
      <span className="item fn"><span className="swatch" />function</span>
      <span className="item intf"><span className="swatch" />interface</span>
      <span className="item cn"><span className="swatch" />const</span>
      <span className="item tp"><span className="swatch" />type</span>
      <span className="item anch"><span className="swatch" />anchor</span>
      <span className="scale">— solid 1.0  - - dashed 0.7  · · dotted 0.5</span>
    </div>
  );
}

interface TopBarProps {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  symbolCount: number;
  sessionId: string;
  search: string;
  onSearch: (s: string) => void;
  onSubmit: () => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
}

function TopBar(props: TopBarProps) {
  // v0.4.4: wordmark + session-info lifted to the AppShell. This sub-bar is
  // now Graph-unique controls only (search box + nodes-shown counter).
  // sessionId / fileCount / symbolCount kept on the prop type for backward
  // compat — referenced via void to silence the unused-arg lint.
  const { nodeCount, edgeCount, sessionId, fileCount, symbolCount, search, onSearch, onSubmit, searchRef } = props;
  void sessionId; void fileCount; void symbolCount;
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
