/**
 * RCA · Evidence Board view.
 *
 * Layout: query bar / 3-column grid (360 dossiers / 1fr graph / 380 inspector) + a
 * 36px bottom 7-signal legend bar. The cosmic styling lives in `rca.css`;
 * the AppShell still owns the actual top bar (Halo wordmark + Graph/RCA/
 * Impact tabs + session HUD), so we don't duplicate it here.
 *
 * Data flow:
 *   1. User types a failure description in the query bar and submits →
 *      POST /api/session/:id/rca for live RCA result (no sidecar needed).
 *      Falls back to GET snapshot if the session has one and no query yet.
 *   2. `callersOf(name, depth=2)` and `calleesOf(name, depth=1)` for the
 *      neighborhood feeding the middle graph.
 *   3. The clicked dossier writes the selection into the zustand session
 *      store, which the side panel then reads to load source + commits.
 */
import { useMemo, useState, useRef, useEffect, type FormEvent } from "react";
import { useQueries, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { CallerTree, CalleeTree, CausalCandidate } from "code-graph-rca";
import { api } from "../../api/client.ts";
import { useSession } from "../../state/session.ts";
import { CandidatesPanel } from "./candidates-panel.tsx";
import { SidePanel } from "./side-panel.tsx";
import { RcaCanvas } from "./rca-canvas.tsx";
import { buildElements } from "../../components/graph/build-elements.ts";
import { SIGNAL_COLORS, SIGNAL_LABELS } from "./signal-radial.tsx";
import "./rca.css";

function parseQuery(raw: string) {
  const s = raw.trim();
  if (s.startsWith("symbol:")) return { kind: "symbol" as const, name: s.slice(7).trim() };
  if (s.startsWith("file:"))   return { kind: "file"   as const, path: s.slice(5).trim() };
  if (s.startsWith("test:"))   return { kind: "failing-test" as const, path: s.slice(5).trim() };
  // plain text treated as a stack trace / prose description
  return { kind: "stack-trace" as const, text: s };
}

export function RcaView({ sessionId }: { sessionId: string }) {
  const selectedSymbol = useSession((s) => s.selectedSymbol);
  const selectSymbol = useSession((s) => s.selectSymbol);
  const scoreThreshold = useSession((s) => s.scoreThreshold);
  const subsystem = useSession((s) => s.subsystem);
  const queryClient = useQueryClient();

  const [queryText, setQueryText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Listen for rca-updated events from the session WebSocket so the snapshot
  // refreshes automatically after `cgrca rca` writes a new sidecar.
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/api/session/${sessionId}/live`);
    ws.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data as string) as { kind: string };
        if (evt.kind === "rca-updated") {
          queryClient.invalidateQueries({ queryKey: ["rca-snapshot", sessionId] });
          queryClient.invalidateQueries({ queryKey: ["rca", sessionId] });
        }
      } catch { /* ignore */ }
    };
    return () => { ws.close(); };
  }, [sessionId, queryClient]);

  // Live mutation — fires when user submits the query bar
  const rcaMutation = useMutation({
    mutationFn: (text: string) => {
      const failure = parseQuery(text);
      return api.rcaQuery(sessionId, { failure });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["rca", sessionId], data);
      selectSymbol(null); // clear stale side-panel selection from previous RCA
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (queryText.trim()) rcaMutation.mutate(queryText);
  };

  // Snapshot fallback — only used before the first live query
  const snapshotQ = useQuery({
    queryKey: ["rca-snapshot", sessionId],
    queryFn: () => api.rca(sessionId),
    retry: false,
  });

  // Active data: live result wins over snapshot
  const rcaData = useQuery({
    queryKey: ["rca", sessionId],
    queryFn: () => Promise.resolve(null), // populated by mutation
    enabled: false,                        // never auto-fetches
    initialData: undefined,
  }).data ?? snapshotQ.data ?? null;

  const isPending = rcaMutation.isPending || (snapshotQ.isPending && !rcaData);
  const error = rcaMutation.error ?? (snapshotQ.error && !rcaData ? snapshotQ.error : null);

  const primary = rcaData?.primarySymbol ?? null;

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
    if (!rcaData) return [];
    return buildElements(rcaData, callers, callees);
  }, [rcaData, callers, callees]);

  const selectedCandidate: CausalCandidate | null = useMemo(() => {
    if (!rcaData || !selectedSymbol) return null;
    return (
      rcaData.causalCandidates.find(
        (c) => c.name === selectedSymbol.name && (c.file ?? null) === (selectedSymbol.file ?? null),
      ) ?? null
    );
  }, [rcaData, selectedSymbol]);

  // ----- Loading / error / empty states (cosmic-styled) -----
  const queryBar = (
    <form className="rca-query-bar" onSubmit={handleSubmit}>
      <input
        ref={inputRef}
        className="rca-query-input"
        value={queryText}
        onChange={(e) => setQueryText(e.target.value)}
        placeholder="symbol:MyFunction  ·  file:src/foo.py  ·  or describe the failure…"
        disabled={rcaMutation.isPending}
      />
      <button className="rca-query-btn" type="submit" disabled={rcaMutation.isPending || !queryText.trim()}>
        {rcaMutation.isPending ? "Running…" : "Investigate"}
      </button>
    </form>
  );

  if (isPending) {
    return (
      <>
        {queryBar}
        <div className="rca-state">Loading the evidence board…</div>
      </>
    );
  }
  if (error) {
    return (
      <>
        {queryBar}
        <div className="rca-state error">
          Failed to load RCA — {String(error)}
        </div>
      </>
    );
  }
  if (!rcaData) {
    return (
      <>
        {queryBar}
        <div className="rca-state">
          Enter a symbol, file, or failure description above to start an investigation.
        </div>
      </>
    );
  }

  const rca = rcaData;

  return (
    <div className="rca-stage">
      {queryBar}
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
