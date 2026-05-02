/**
 * Impact tab — Forward Constellation (Observatory grammar).
 *
 * Single full-width Cytoscape canvas narrowed to forward-reachable nodes
 * from a chosen seed symbol. Reuses the Graph view's overlay stack: nebula
 * clouds per file, anchor-overlay (lens flare + concentric rings) on the
 * seed, and smart-labels for collision-avoided text. Risk is encoded as the
 * node FILL color (cyan → amber → halo-red); test coverage is encoded as
 * the node RING (solid green halo for tested, dashed red for untested).
 *
 * Layout grid (top → bottom):
 *   topbar (56) · controls (48) · canvas (1fr) · legend (36)
 *
 * The control bar holds the symbol-search picker, depth slider, run button,
 * and the seed/stats HUD (max-risk, affected, files, depth — color-coded
 * by severity). Selection sync via the global session zustand store is
 * preserved so node clicks still propagate to RCA / Graph.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ImpactNode, ImpactRequest, ImpactResponse } from "@shared/api";
import { api } from "../../api/client.ts";
import { useSession } from "../../state/session.ts";
import { SymbolSearch } from "./symbol-search.tsx";
import { ImpactCanvas } from "./impact-canvas.tsx";
import { FileBlastRadius, computeFileRollups } from "./file-blast-radius.tsx";
import "./impact.css";

export function ImpactView({ sessionId }: { sessionId: string }) {
  const selectedSymbol = useSession((s) => s.selectedSymbol);
  const selectSymbol = useSession((s) => s.selectSymbol);

  const [query, setQuery] = useState<string>(selectedSymbol?.name ?? "");
  const [pickedFile, setPickedFile] = useState<string | null>(selectedSymbol?.file ?? null);
  const [depth, setDepth] = useState<number>(3);
  const [response, setResponse] = useState<ImpactResponse | null>(null);

  // Session HUD numbers (mirrors the graph topbar's session line).
  const sessionsQ = useQuery({ queryKey: ["sessions"], queryFn: () => api.sessions() });
  const sessionMeta = sessionsQ.data?.sessions.find((s) => s.id === sessionId) ?? null;

  // Prefill from session selection if it changes (e.g. arrival from RCA view).
  useEffect(() => {
    if (selectedSymbol?.name) {
      setQuery(selectedSymbol.name);
      setPickedFile(selectedSymbol.file ?? null);
    }
  }, [selectedSymbol]);

  const mutation = useMutation({
    mutationFn: (body: ImpactRequest) => api.impact(sessionId, body),
    onSuccess: (res) => setResponse(res),
  });

  function run(): void {
    const name = query.trim();
    if (!name) return;
    const body: ImpactRequest = pickedFile
      ? { symbolName: name, file: pickedFile, depth }
      : { symbolName: name, depth };
    mutation.mutate(body);
  }

  const selectedKey = useMemo(() => {
    if (!selectedSymbol) return null;
    if (selectedSymbol.file === null || selectedSymbol.line === null) return null;
    return `${selectedSymbol.name}@${selectedSymbol.file}:${selectedSymbol.line}`;
  }, [selectedSymbol]);

  function handleSelect(node: ImpactNode): void {
    selectSymbol({ name: node.name, file: node.file, line: node.line });
  }

  // Stats — derived purely from the response.
  const stats = useMemo(() => deriveStats(response), [response]);
  const fileCount = useMemo(
    () => (response ? computeFileRollups(response.nodes).length : 0),
    [response],
  );

  // Wordmark + tabs + session HUD removed — the AppShell topbar (v0.4.3)
  // owns those now. Keep this stage focused on Impact-unique controls.
  void sessionMeta;
  return (
    <div className="impact-stage">
      {/* Control bar — seed + symbol picker + depth + run + stats. */}
      <div className="controls">
        <div className="seed">
          <span className="lbl">Seed</span>
          <span className="val">{response?.seed.name ?? (query.trim() || "—")}</span>
          {response ? (
            <span className="file">{response.seed.file}:{response.seed.line}</span>
          ) : pickedFile ? (
            <span className="file">{pickedFile}</span>
          ) : null}
        </div>
        <SymbolSearch
          variant="observatory"
          sessionId={sessionId}
          value={query}
          onChange={(v) => {
            setQuery(v);
            setPickedFile(null);
          }}
          onPick={(d) => {
            setQuery(d.name);
            setPickedFile(d.file);
          }}
          onSubmit={run}
          placeholder="search symbol…"
        />
        <label className="depth">
          <span>depth</span>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
          />
          <span className="v">{depth}</span>
        </label>
        <button
          type="button"
          className="run-btn"
          onClick={run}
          disabled={mutation.isPending || !query.trim()}
        >
          {mutation.isPending ? "Running…" : "Run impact"}
        </button>
        <div className="stats">
          <div className={`stat ${riskTone(stats.maxRisk)}`}>
            <span className="v">{stats.maxRisk.toFixed(2)}</span>
            <span className="l">max risk</span>
          </div>
          <div className="stat warn">
            <span className="v">{stats.affected}</span>
            <span className="l">affected</span>
          </div>
          <div className="stat">
            <span className="v">{fileCount}</span>
            <span className="l">files</span>
          </div>
          <div className="stat">
            <span className="v">{stats.depth}</span>
            <span className="l">depth</span>
          </div>
        </div>
      </div>

      {/* Canvas region — single Cytoscape constellation + overlays. */}
      <div className="canvas-region">
        {mutation.isError ? (
          <div className="impact-error">
            {(mutation.error as Error)?.message ?? "Impact request failed."}
          </div>
        ) : !response ? (
          <Placeholder pending={mutation.isPending} />
        ) : (
          <>
            <ImpactCanvas
              response={response}
              onSelect={handleSelect}
              selectedKey={selectedKey}
            />
            <SummaryProse response={response} fileCount={fileCount} />
            <FileBlastRadius nodes={response.nodes} onFocus={handleSelect} />
          </>
        )}
      </div>

      {/* Bottom legend. */}
      <div className="impact-legend">
        <span className="seg"><span className="swatch" style={{ background: "#ff5c6a" }} />seed</span>
        <span className="seg"><span className="swatch" style={{ background: "#ff5c6a" }} />risk ≥ 0.75</span>
        <span className="seg"><span className="swatch" style={{ background: "#ffb547" }} />0.5–0.74</span>
        <span className="seg"><span className="swatch" style={{ background: "#5cd5ff" }} />&lt; 0.5</span>
        <span className="seg">file = nebula · ring = test coverage</span>
        <span className="seg" style={{ marginLeft: "auto", color: "rgba(245,245,245,0.18)" }}>
          click a node · selection syncs to RCA / Graph
        </span>
      </div>
    </div>
  );
}

interface Stats {
  maxRisk: number;
  affected: number;
  depth: number;
}

function deriveStats(r: ImpactResponse | null): Stats {
  if (!r) return { maxRisk: 0, affected: 0, depth: 0 };
  let maxDepth = 0;
  for (const n of r.nodes) {
    if (n.distance > maxDepth) maxDepth = n.distance;
  }
  return { maxRisk: r.maxRisk, affected: r.nodes.length, depth: maxDepth };
}

function riskTone(r: number): "hot" | "warn" | "cool" {
  if (r >= 0.75) return "hot";
  if (r >= 0.5) return "warn";
  return "cool";
}

function SummaryProse({
  response,
  fileCount,
}: {
  response: ImpactResponse;
  fileCount: number;
}) {
  // Find the worst-impact file (one with the highest single-symbol risk).
  const rollups = computeFileRollups(response.nodes);
  const worst = rollups[0] ?? null;
  return (
    <div className="impact-summary">
      Changing <span className="em">{response.seed.name}</span> propagates across{" "}
      <span className="mono">{fileCount} files</span>
      {worst ? (
        <>
          , with the worst impact landing in{" "}
          <span className="em">{worst.basename}</span>.
        </>
      ) : (
        "."
      )}
    </div>
  );
}

function Placeholder({ pending }: { pending: boolean }) {
  return (
    <div className="impact-placeholder">
      <div className="lit">
        {pending
          ? "Computing forward impact…"
          : "Pick a symbol, set the depth, and run impact."}
      </div>
      <div className="sub">
        Walks forward from a chosen symbol through its callers, scoring each
        for risk and overlaying test coverage. Answers “if I change X, what
        breaks?”
      </div>
    </div>
  );
}
