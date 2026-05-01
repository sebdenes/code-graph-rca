import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client.ts";
import { useSession } from "./state/session.ts";
import { AppShell } from "./components/shell.tsx";
import { RcaView } from "./views/rca/rca-view.tsx";
import { ImpactView } from "./views/impact/impact-view.tsx";
import { GraphView } from "./views/graph/graph-view.tsx";

export default function App() {
  const sessionId = useSession((s) => s.sessionId);
  const setSessionId = useSession((s) => s.setSessionId);
  const view = useSession((s) => s.view);

  const sessionsQ = useQuery({ queryKey: ["sessions"], queryFn: () => api.sessions() });

  useEffect(() => {
    if (!sessionId && sessionsQ.data?.sessions[0]) {
      setSessionId(sessionsQ.data.sessions[0].id);
    }
  }, [sessionId, sessionsQ.data, setSessionId]);

  return (
    <AppShell sessions={sessionsQ.data?.sessions ?? []}>
      {!sessionId ? (
        <EmptyState loading={sessionsQ.isPending} />
      ) : view === "graph" ? (
        <GraphView sessionId={sessionId} />
      ) : view === "rca" ? (
        <RcaView sessionId={sessionId} />
      ) : (
        <ImpactView sessionId={sessionId} />
      )}
    </AppShell>
  );
}

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      {loading ? "Loading sessions…" : "No sessions yet — run `cgrca rca <failure> --persist <path>` first."}
    </div>
  );
}
