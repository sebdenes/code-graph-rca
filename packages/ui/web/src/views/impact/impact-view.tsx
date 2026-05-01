import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ImpactNode, ImpactRequest, ImpactResponse } from "@shared/api";
import { api } from "../../api/client.ts";
import { useSession } from "../../state/session.ts";
import { cn, scoreColor } from "../../lib/utils.ts";
import { SymbolSearch } from "./symbol-search.tsx";
import { ImpactTree, nodeKey } from "./impact-tree.tsx";
import { ImpactTable } from "./impact-table.tsx";
import { RiskSummary } from "./risk-summary.tsx";

export function ImpactView({ sessionId }: { sessionId: string }) {
  const selectedSymbol = useSession((s) => s.selectedSymbol);
  const selectSymbol = useSession((s) => s.selectSymbol);

  const [query, setQuery] = useState<string>(selectedSymbol?.name ?? "");
  const [pickedFile, setPickedFile] = useState<string | null>(selectedSymbol?.file ?? null);
  const [depth, setDepth] = useState<number>(3);
  const [response, setResponse] = useState<ImpactResponse | null>(null);

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

  function run() {
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

  function handleSelect(node: ImpactNode) {
    selectSymbol({ name: node.name, file: node.file, line: node.line });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-2 text-sm">
        <SymbolSearch
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
        />
        <label className="flex items-center gap-2 text-muted-foreground">
          <span>depth</span>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="w-32"
          />
          <span className="w-4 text-right font-mono text-foreground">{depth}</span>
        </label>
        <button
          type="button"
          onClick={run}
          disabled={mutation.isPending || !query.trim()}
          className={cn(
            "rounded bg-accent px-3 py-1 text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {mutation.isPending ? "Running…" : "Run impact"}
        </button>
        {pickedFile && (
          <span className="truncate text-xs text-muted-foreground" title={pickedFile}>
            in {pickedFile}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {mutation.isError ? (
          <ErrorBanner message={(mutation.error as Error)?.message ?? "Impact request failed."} />
        ) : !response ? (
          <Placeholder pending={mutation.isPending} />
        ) : (
          <Loaded
            response={response}
            selectedKey={selectedKey}
            onSelect={handleSelect}
          />
        )}
      </div>
    </div>
  );
}

function Loaded({
  response,
  selectedKey,
  onSelect,
}: {
  response: ImpactResponse;
  selectedKey: string | null;
  onSelect: (node: ImpactNode) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2">
        <RiskSummary maxRisk={response.maxRisk} />
        <div className="mt-1 text-xs text-muted-foreground">
          Seed: <span className="font-mono text-foreground">{response.seed.name}</span>{" "}
          {response.seed.file}:{response.seed.line} · {response.nodes.length} affected node(s)
        </div>
      </div>
      <div className="grid flex-1 grid-cols-12 overflow-hidden">
        <aside className="col-span-3 overflow-auto border-r border-border">
          <SectionHeader>Tree</SectionHeader>
          <ImpactTree root={response.tree} selectedKey={selectedKey} onSelect={onSelect} />
        </aside>
        <section className="col-span-5 overflow-hidden border-r border-border">
          <SectionHeader>Graph</SectionHeader>
          <GraphFallback nodes={response.nodes} selectedKey={selectedKey} onSelect={onSelect} />
        </section>
        <aside className="col-span-4 overflow-hidden">
          <SectionHeader>Ranked by risk</SectionHeader>
          <div className="h-[calc(100%-1.75rem)]">
            <ImpactTable nodes={response.nodes} selectedKey={selectedKey} onSelect={onSelect} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-border bg-muted/30 px-3 py-1 text-[11px] uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

function GraphFallback({
  nodes,
  selectedKey,
  onSelect,
}: {
  nodes: ImpactNode[];
  selectedKey: string | null;
  onSelect: (node: ImpactNode) => void;
}) {
  // Group by hop distance for an at-a-glance forward-propagation layout.
  const byDistance = useMemo(() => {
    const m = new Map<number, ImpactNode[]>();
    for (const n of nodes) {
      const arr = m.get(n.distance) ?? [];
      arr.push(n);
      m.set(n.distance, arr);
    }
    return Array.from(m.entries()).sort((a, b) => a[0] - b[0]);
  }, [nodes]);

  return (
    <div className="h-[calc(100%-1.75rem)] overflow-auto p-3">
      <div className="flex flex-col gap-3">
        {byDistance.map(([dist, group]) => (
          <div key={dist}>
            <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              Hop {dist} · {group.length} node(s)
            </div>
            <div className="flex flex-wrap gap-2">
              {group
                .slice()
                .sort((a, b) => b.riskScore - a.riskScore)
                .map((n, i) => {
                  const k = nodeKey(n);
                  const isSelected = selectedKey === k;
                  const tested = n.testCoverage.length > 0;
                  return (
                    <button
                      key={`${k}#${i}`}
                      type="button"
                      onClick={() => onSelect(n)}
                      className={cn(
                        "flex max-w-xs flex-col gap-1 rounded border border-border bg-muted/40 px-2 py-1 text-left text-xs hover:bg-muted",
                        isSelected && "ring-2 ring-accent",
                      )}
                      style={{ borderLeftColor: scoreColor(n.riskScore * 10), borderLeftWidth: 4 }}
                    >
                      <span className="truncate font-mono text-foreground">{n.name}</span>
                      <span className="truncate text-[10px] text-muted-foreground">
                        {n.file}:{n.line}
                      </span>
                      <span className="flex items-center gap-1 text-[10px]">
                        <span
                          className="inline-flex h-4 min-w-9 items-center justify-center rounded px-1 font-semibold text-background"
                          style={{ backgroundColor: scoreColor(n.riskScore * 10) }}
                        >
                          {n.riskScore.toFixed(2)}
                        </span>
                        <span className={tested ? "text-emerald-400" : "text-red-400"}>
                          {tested ? "✓" : "✗"}
                        </span>
                        {n.recentChanges.length > 0 && (
                          <span className="text-amber-400">Δ{n.recentChanges.length}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
        {byDistance.length === 0 && (
          <div className="text-xs text-muted-foreground">No nodes returned.</div>
        )}
      </div>
    </div>
  );
}

function Placeholder({ pending }: { pending: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-muted-foreground">
      <div className="text-sm">
        {pending
          ? "Computing forward impact…"
          : "Pick a symbol and depth, then run impact analysis."}
      </div>
      <div className="max-w-md text-xs">
        This view walks forward from a chosen symbol through its callers, scoring each one for
        risk and overlaying test coverage and recent change history. Use it to answer
        “if I change X, what breaks?”
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="m-4 rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-400">
      {message}
    </div>
  );
}
