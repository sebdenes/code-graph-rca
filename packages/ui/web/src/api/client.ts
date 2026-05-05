import type {
  BlameResponse,
  DiffResponse,
  GraphResponse,
  ImpactRequest,
  ImpactResponse,
  QueryRequest,
  QueryResponse,
  RcaQuery,
  RcaSnapshot,
  SessionsResponse,
  SourceResponse,
} from "@shared/api";

const BASE = "/api";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const api = {
  async sessions(): Promise<SessionsResponse> {
    return j(await fetch(`${BASE}/sessions`));
  },
  async graph(sessionId: string, opts: { maxSymbols?: number } = {}): Promise<GraphResponse> {
    const qs = opts.maxSymbols ? `?maxSymbols=${opts.maxSymbols}` : "";
    return j(await fetch(`${BASE}/session/${encodeURIComponent(sessionId)}/graph${qs}`));
  },
  async rca(sessionId: string): Promise<RcaSnapshot> {
    return j(await fetch(`${BASE}/session/${encodeURIComponent(sessionId)}/rca`));
  },
  async rcaQuery(sessionId: string, body: RcaQuery): Promise<RcaSnapshot> {
    return j(
      await fetch(`${BASE}/session/${encodeURIComponent(sessionId)}/rca`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async query(sessionId: string, body: QueryRequest): Promise<QueryResponse> {
    return j(
      await fetch(`${BASE}/session/${encodeURIComponent(sessionId)}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async source(sessionId: string, path: string): Promise<SourceResponse> {
    return j(await fetch(`${BASE}/session/${encodeURIComponent(sessionId)}/source/${encodePath(path)}`));
  },
  async blame(sessionId: string, path: string): Promise<BlameResponse> {
    return j(await fetch(`${BASE}/session/${encodeURIComponent(sessionId)}/blame/${encodePath(path)}`));
  },
  async diff(sessionId: string, sha: string): Promise<DiffResponse> {
    return j(await fetch(`${BASE}/session/${encodeURIComponent(sessionId)}/diff/${encodeURIComponent(sha)}`));
  },
  async impact(sessionId: string, body: ImpactRequest): Promise<ImpactResponse> {
    return j(
      await fetch(`${BASE}/session/${encodeURIComponent(sessionId)}/impact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  /**
   * Bridge mode: publish the user's current selection to the local bridge
   * channel. Best-effort, fire-and-forget — failures are swallowed so the UI
   * keeps working when no MCP peer is connected.
   */
  async bridgePostSelect(
    payload: { name: string; file: string; line: number; subsystem?: string } | null,
  ): Promise<void> {
    try {
      await fetch(`${BASE}/bridge/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // ignore
    }
  },
  async bridgeGetSelect(): Promise<
    { name: string; file: string; line: number; subsystem?: string } | { none: true }
  > {
    return j(await fetch(`${BASE}/bridge/select`));
  },
};

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
