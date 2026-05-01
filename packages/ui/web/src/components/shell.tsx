import type { ReactNode } from "react";
import type { SessionSummary } from "@shared/api";
import { useSession } from "../state/session.ts";
import { cn } from "../lib/utils.ts";

interface Props {
  sessions: SessionSummary[];
  children: ReactNode;
}

export function AppShell({ sessions, children }: Props) {
  const sessionId = useSession((s) => s.sessionId);
  const setSessionId = useSession((s) => s.setSessionId);
  const view = useSession((s) => s.view);
  const setView = useSession((s) => s.setView);

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex items-center gap-4 border-b border-border px-4 py-2 text-sm">
        <div className="font-mono text-base font-semibold">cgrca-view</div>

        <div className="ml-4 flex items-center gap-2">
          <label className="text-muted-foreground">session</label>
          <select
            className="rounded border border-border bg-muted px-2 py-1 text-foreground"
            value={sessionId ?? ""}
            onChange={(e) => setSessionId(e.target.value || null)}
          >
            {sessions.length === 0 && <option value="">(none)</option>}
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} — {s.primarySymbol ?? "?"} ({s.fileCount}f / {s.symbolCount}s)
              </option>
            ))}
          </select>
        </div>

        <nav className="ml-auto flex gap-1">
          {(["graph", "rca", "impact"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "rounded px-3 py-1 text-sm uppercase tracking-wider",
                v === view ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {v}
            </button>
          ))}
        </nav>
      </header>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
