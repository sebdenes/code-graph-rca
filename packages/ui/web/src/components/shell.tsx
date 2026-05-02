/**
 * AppShell — Observatory-styled topbar (Halo wordmark + Graph/RCA/Impact tabs
 * + session HUD) wrapping the active stage. The cosmic palette + typography
 * are scoped in `shell.css` so they don't leak into other surfaces that still
 * lean on the Tailwind tokens declared in `index.css`.
 *
 * Per-tab views (graph, rca, impact) render their own internal topbars too;
 * this shell sits ABOVE them so the seam now reads as a single cohesive bar.
 */
import type { ReactNode } from "react";
import type { SessionSummary } from "@shared/api";
import { useSession } from "../state/session.ts";
import "./shell.css";

// Injected by Vite from packages/ui/package.json#version (see vite.config.ts).
declare const __APP_VERSION__: string;

interface Props {
  sessions: SessionSummary[];
  children: ReactNode;
}

const TABS = ["graph", "rca", "impact"] as const;

export function AppShell({ sessions, children }: Props) {
  const sessionId = useSession((s) => s.sessionId);
  const setSessionId = useSession((s) => s.setSessionId);
  const view = useSession((s) => s.view);
  const setView = useSession((s) => s.setView);

  const active = sessions.find((s) => s.id === sessionId) ?? null;

  return (
    <div className="app-shell">
      <header className="app-shell-topbar">
        <div className="brand-halo">
          Halo<span className="dot" />
        </div>

        <nav className="tabs">
          {TABS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={v === view ? "active" : undefined}
            >
              {v}
            </button>
          ))}
        </nav>

        <div className="session">
          <select
            className="session-select"
            value={sessionId ?? ""}
            onChange={(e) => setSessionId(e.target.value || null)}
            aria-label="session"
          >
            {sessions.length === 0 && <option value="">(none)</option>}
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} — {s.primarySymbol ?? "?"}
              </option>
            ))}
          </select>
          {active && (
            <>
              <span>
                <strong>{active.fileCount}</strong> files
              </span>
              <span>
                <strong>{active.symbolCount}</strong> symbols
              </span>
              <span>
                <strong>{active.edgeCount}</strong> edges
              </span>
            </>
          )}
          <span>
            v
            {typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0"}
          </span>
        </div>
      </header>
      <main className="app-shell-main">{children}</main>
    </div>
  );
}
