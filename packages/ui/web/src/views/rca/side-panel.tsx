import { useQueries } from "@tanstack/react-query";
import type {
  CallerTree,
  CalleeTree,
  CausalCandidate,
  Definition,
  RecentChange,
} from "code-graph-rca";
import { api } from "../../api/client.ts";

interface Props {
  sessionId: string;
  selectedSymbol: { name: string; file: string | null; line: number | null } | null;
  candidate: CausalCandidate | null;
}

export function SidePanel({ sessionId, selectedSymbol, candidate }: Props) {
  if (!selectedSymbol) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        Select a node to see details.
      </div>
    );
  }

  const name = selectedSymbol.name;
  const enabled = Boolean(name);
  const queries = useQueries({
    queries: [
      {
        queryKey: ["definitionOf", sessionId, name],
        queryFn: () => api.query(sessionId, { name: "definitionOf", args: { name } }),
        enabled,
      },
      {
        queryKey: ["callersOf", sessionId, name, 1],
        queryFn: () => api.query(sessionId, { name: "callersOf", args: { name, depth: 1 } }),
        enabled,
      },
      {
        queryKey: ["calleesOf", sessionId, name, 1],
        queryFn: () => api.query(sessionId, { name: "calleesOf", args: { name, depth: 1 } }),
        enabled,
      },
    ],
  });

  const defQ = queries[0];
  const callersQ = queries[1];
  const calleesQ = queries[2];

  const defResp = defQ.data;
  const def: Definition | null =
    defResp && defResp.name === "definitionOf"
      ? (defResp.result.find((d) => matchesFile(d.file, selectedSymbol.file)) ?? defResp.result[0] ?? null)
      : null;

  const callersResp = callersQ.data;
  const callers: CallerTree | null =
    callersResp && callersResp.name === "callersOf" ? callersResp.result : null;

  const calleesResp = calleesQ.data;
  const callees: CalleeTree | null =
    calleesResp && calleesResp.name === "calleesOf" ? calleesResp.result : null;

  const fileLine = def
    ? `${def.file}:${def.startLine}`
    : selectedSymbol.file
    ? `${selectedSymbol.file}${selectedSymbol.line ? ":" + selectedSymbol.line : ""}`
    : null;

  const resolvedCallees = (callees?.callees ?? []).filter((c) => c.resolved);
  const unresolvedCallees = (callees?.callees ?? []).filter((c) => !c.resolved);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-border px-3 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="font-mono text-base font-semibold break-all">{name}</h2>
          {def?.kind && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs uppercase text-muted-foreground">
              {def.kind}
            </span>
          )}
        </div>
        {fileLine && (
          <button
            onClick={() => {
              // The future code-pane agent will listen for this event.
              window.dispatchEvent(new CustomEvent("cgrca:open-source", { detail: { file: def?.file ?? selectedSymbol.file, line: def?.startLine ?? selectedSymbol.line } }));
              // eslint-disable-next-line no-console
              console.log("[rca] open-source", fileLine);
            }}
            className="mt-1 block truncate text-xs font-mono text-muted-foreground hover:text-foreground hover:underline"
          >
            {fileLine}
          </button>
        )}
        {def?.signature && (
          <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted px-2 py-1 text-xs font-mono whitespace-pre-wrap break-all">
            {def.signature}
          </pre>
        )}
      </div>

      {candidate && (
        <Section title="Score Breakdown">
          <div className="px-3 pb-3">
            <table className="w-full text-xs">
              <tbody>
                <SignalRow label="Recency" value={candidate.signals.recencyScore} />
                <SignalRow label="Proximity" value={candidate.signals.proximityScore} />
                <SignalRow label="Ambiguity" value={candidate.signals.ambiguityScore} />
                <SignalRow label="Co-Change" value={candidate.signals.coChangeScore} />
                <SignalRow label="Subsystem" value={candidate.signals.subsystemScore} />
                <tr className="border-t border-border">
                  <td className="py-1 font-semibold">Total</td>
                  <td className="py-1 text-right font-mono font-semibold">
                    {candidate.score.toFixed(2)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {candidate && candidate.recentChanges.length > 0 && (
        <Section title="Recent Changes">
          <ul className="px-3 pb-3 text-xs">
            {candidate.recentChanges.map((rc) => (
              <ChangeRow key={rc.commit} change={rc} />
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Callers (${callers?.callers.length ?? 0})`}>
        <ListBody loading={callersQ.isPending}>
          {callers && callers.callers.length === 0 && <Empty>No callers in scope.</Empty>}
          {callers?.callers.map((c, i) => (
            <li key={`${c.file}:${c.name}:${i}`} className="px-3 py-1 text-xs">
              <span className="font-mono">{c.name}</span>{" "}
              <span className="text-muted-foreground">
                ({c.file}:{c.line})
              </span>
            </li>
          ))}
        </ListBody>
      </Section>

      <Section title={`Callees (${resolvedCallees.length})`}>
        <ListBody loading={calleesQ.isPending}>
          {resolvedCallees.length === 0 && <Empty>No callees in scope.</Empty>}
          {resolvedCallees.map((c, i) => (
            <li key={`${c.file ?? "?"}:${c.name}:${i}`} className="px-3 py-1 text-xs">
              <span className="font-mono">{c.name}</span>{" "}
              <span className="text-muted-foreground">
                ({c.file ?? "?"}:{c.line ?? "?"})
              </span>
            </li>
          ))}
        </ListBody>
        {unresolvedCallees.length > 0 && (
          <>
            <div className="border-t border-border px-3 py-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              Unresolved calls
            </div>
            <ul>
              {unresolvedCallees.map((c, i) => (
                <li key={`u:${c.name}:${i}`} className="px-3 py-1 text-xs text-muted-foreground">
                  <span className="font-mono italic">{c.name}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      {(defQ.error || callersQ.error || calleesQ.error) && (
        <div className="border-t border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700">
          {String(defQ.error ?? callersQ.error ?? calleesQ.error)}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border">
      <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function SignalRow({ label, value }: { label: string; value: number }) {
  return (
    <tr>
      <td className="py-0.5 text-muted-foreground">{label}</td>
      <td className="py-0.5 text-right font-mono">{value.toFixed(2)}</td>
    </tr>
  );
}

function ChangeRow({ change }: { change: RecentChange }) {
  return (
    <li>
      <button
        onClick={() => {
          // Stub for future diff modal.
          // eslint-disable-next-line no-console
          console.log("[rca] open-diff", change.commit);
        }}
        className="flex w-full items-baseline gap-2 py-0.5 text-left hover:underline"
      >
        <span className="font-mono">{change.commit.slice(0, 7)}</span>
        <span className="flex-1 truncate">{change.subject}</span>
        <span className="text-muted-foreground">{change.daysAgo}d</span>
      </button>
    </li>
  );
}

function ListBody({ loading, children }: { loading: boolean; children: React.ReactNode }) {
  if (loading) {
    return <div className="px-3 py-2 text-xs text-muted-foreground animate-pulse">Loading…</div>;
  }
  return <ul className="pb-2">{children}</ul>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <li className="px-3 py-1 text-xs text-muted-foreground">{children}</li>;
}

function matchesFile(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a === b;
}

