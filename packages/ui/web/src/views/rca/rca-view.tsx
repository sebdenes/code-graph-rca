/**
 * RCA · Evidence Board view.
 *
 * Layout: 3-column grid (360 dossiers / 1fr graph / 380 inspector) + a
 * 36px bottom 7-signal legend bar. The cosmic styling lives in `rca.css`;
 * the AppShell still owns the actual top bar (Halo wordmark + Graph/RCA/
 * Impact tabs + session HUD), so we don't duplicate it here.
 *
 * Data flow is unchanged from the previous version:
 *   1. `api.rca(sessionId)` for the snapshot (anchor + ranked candidates).
 *   2. `callersOf(name, depth=2)` and `calleesOf(name, depth=1)` for the
 *      neighborhood feeding the middle graph.
 *   3. The clicked dossier writes the selection into the zustand session
 *      store, which the side panel then reads to load source + commits.
 */
import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { CallerTree, CalleeTree, CausalCandidate } from "code-graph-rca";
import { api } from "../../api/client.ts";
import { useSession } from "../../state/session.ts";
import { CandidatesPanel } from "./candidates-panel.tsx";
import { SidePanel } from "./side-panel.tsx";
import { RcaCanvas } from "./rca-canvas.tsx";
import { buildElements } from "../../components/graph/build-elements.ts";
import { SIGNAL_COLORS, SIGNAL_LABELS } from "./signal-radial.tsx";
import "./rca.css";

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

  // ----- Loading / error / empty states (cosmic-styled) -----
  if (rcaQ.isPending) {
    return <div className="rca-state">Loading the evidence board…</div>;
  }
  if (rcaQ.error) {
    return (
      <div className="rca-state error">
        Failed to load RCA — {String(rcaQ.error)}
      </div>
    );
  }
  if (!rcaQ.data) {
    return <div className="rca-state">No RCA snapshot available.</div>;
  }

  const rca = rcaQ.data;

  return (
    <div className="rca-stage">
      <CandidatesPanel
        candidates={rca.causalCandidates}
        selectedSymbol={selectedSymbol}
        anchorName={rca.primarySymbol}
        onSelect={(c) =>
          selectSymbol({
            name: c.name,
            file: c.file ?? null,
            line: c.line ?? null,
          })
        }
      />

      <section className="rca-middle">
        {(callersQ.isPending || calleesQ.isPending) && elements.length === 0 ? (
          <div className="rca-graph-empty">Loading neighborhood…</div>
        ) : callersQ.error || calleesQ.error ? (
          <div className="rca-graph-error">
            Failed to load neighborhood: {String(callersQ.error ?? calleesQ.error)}
          </div>
        ) : (
          <RcaCanvas
            elements={elements}
            selectedSymbol={selectedSymbol}
            scoreThreshold={scoreThreshold}
            subsystem={subsystem}
            onSelect={selectSymbol}
          />
        )}
      </section>

      <SidePanel
        sessionId={sessionId}
        selectedSymbol={selectedSymbol}
        candidate={selectedCandidate}
      />

      <div className="rca-bottom-bar">
        {SIGNAL_LABELS.map((s) => (
          <span key={s.key} className="seg">
            <span
              className="swatch"
              style={{ background: SIGNAL_COLORS[s.key] }}
            />
            {s.short}
          </span>
        ))}
        <span className="scale">
          7-signal radial · ray length = score
        </span>
      </div>
    </div>
  );
}
