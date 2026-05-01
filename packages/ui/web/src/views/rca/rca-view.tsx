import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { CallerTree, CalleeTree, CausalCandidate } from "code-graph-rca";
import { api } from "../../api/client.ts";
import { useSession } from "../../state/session.ts";
import { CandidatesPanel } from "./candidates-panel.tsx";
import { SidePanel } from "./side-panel.tsx";
import { Graph } from "../../components/graph/graph.tsx";
import { buildElements } from "../../components/graph/build-elements.ts";

export function RcaView({ sessionId }: { sessionId: string }) {
  const selectedSymbol = useSession((s) => s.selectedSymbol);
  const selectSymbol = useSession((s) => s.selectSymbol);
  const scoreThreshold = useSession((s) => s.scoreThreshold);
  const subsystem = useSession((s) => s.subsystem);

  const rcaQ = useQuery({
    queryKey: ["rca", sessionId],
    queryFn: () => api.rca(sessionId),
  });

  const primary = rcaQ.data?.primarySymbol ?? null;

  const neighborhoodQs = useQueries({
    queries: [
      {
        queryKey: ["callersOf", sessionId, primary, 2],
        queryFn: () =>
          api.query(sessionId, { name: "callersOf", args: { name: primary, depth: 2 } }),
        enabled: Boolean(primary),
      },
      {
        queryKey: ["calleesOf", sessionId, primary, 1],
        queryFn: () =>
          api.query(sessionId, { name: "calleesOf", args: { name: primary, depth: 1 } }),
        enabled: Boolean(primary),
      },
    ],
  });

  const callersQ = neighborhoodQs[0];
  const calleesQ = neighborhoodQs[1];

  const callers: CallerTree | null =
    callersQ.data && callersQ.data.name === "callersOf" ? callersQ.data.result : null;
  const callees: CalleeTree | null =
    calleesQ.data && calleesQ.data.name === "calleesOf" ? calleesQ.data.result : null;

  const elements = useMemo(() => {
    if (!rcaQ.data) return [];
    return buildElements(rcaQ.data, callers, callees);
  }, [rcaQ.data, callers, callees]);

  const selectedCandidate: CausalCandidate | null = useMemo(() => {
    if (!rcaQ.data || !selectedSymbol) return null;
    return (
      rcaQ.data.causalCandidates.find(
        (c) => c.name === selectedSymbol.name && (c.file ?? null) === (selectedSymbol.file ?? null),
      ) ?? null
    );
  }, [rcaQ.data, selectedSymbol]);

  // Loading state
  if (rcaQ.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground animate-pulse">
        Loading graph…
      </div>
    );
  }

  // Error state
  if (rcaQ.error) {
    return (
      <div className="m-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700">
        Failed to load RCA: {String(rcaQ.error)}
      </div>
    );
  }

  if (!rcaQ.data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No RCA snapshot.
      </div>
    );
  }

  const rca = rcaQ.data;

  return (
    <div className="flex h-full">
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-border">
        <CandidatesPanel
          candidates={rca.causalCandidates}
          selectedSymbol={selectedSymbol}
          onSelect={(c) => selectSymbol({ name: c.name, file: c.file ?? null, line: c.line ?? null })}
        />
      </aside>

      <section className="relative flex-1 min-w-0">
        {(callersQ.isPending || calleesQ.isPending) && elements.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground animate-pulse">
            Loading graph…
          </div>
        ) : (callersQ.error || calleesQ.error) ? (
          <div className="m-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700">
            Failed to load neighborhood: {String(callersQ.error ?? calleesQ.error)}
          </div>
        ) : (
          <Graph
            elements={elements}
            selectedSymbol={selectedSymbol}
            scoreThreshold={scoreThreshold}
            subsystem={subsystem}
            onSelect={selectSymbol}
          />
        )}
      </section>

      <aside className="flex w-[360px] shrink-0 flex-col border-l border-border">
        <SidePanel
          sessionId={sessionId}
          selectedSymbol={selectedSymbol}
          candidate={selectedCandidate}
        />
      </aside>
    </div>
  );
}
