/**
 * React-Query hook that fetches a `GraphResponse` and converts it to a
 * cytoscape elements list memoized for stable identity. Every consumer
 * downstream (CyCanvas, Inspector) depends on the memoized array — handing
 * out a fresh reference each render would force cy to rebuild its element
 * graph on every parent re-render.
 *
 * Constellation extension: opportunistically fetch the RCA sidecar so the
 * canvas can render causal halos and recency rings when the session has a
 * sibling `.rca.json`. A 404 (no sidecar) is silently swallowed; halos and
 * rings simply don't render in that case.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ElementDefinition } from "cytoscape";
import type { GraphResponse, RcaSnapshot } from "@shared/api";
import { api } from "@/api/client.ts";
import { buildElements } from "./build-elements.ts";

export interface UseGraphDataOptions {
  sessionId: string;
  maxSymbols: number;
}

export interface GraphData {
  raw: GraphResponse;
  elements: ElementDefinition[];
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  truncated: boolean;
  /** RCA sidecar if present; null when the session has no `.rca.json`. */
  rca: RcaSnapshot | null;
}

export function useGraphData(opts: UseGraphDataOptions) {
  const { sessionId, maxSymbols } = opts;

  const query = useQuery<GraphResponse>({
    queryKey: ["graph", sessionId, maxSymbols],
    queryFn: () => api.graph(sessionId, { maxSymbols }),
  });

  // Opportunistic RCA fetch — silently null on 404. We do NOT block the
  // graph render on this; halos appear when the sidecar arrives.
  const rcaQuery = useQuery<RcaSnapshot | null>({
    queryKey: ["rca", sessionId],
    queryFn: () => api.rca(sessionId).catch(() => null),
    retry: false,
    staleTime: 60_000,
  });

  const data: GraphData | null = useMemo(() => {
    if (!query.data) return null;
    return {
      raw: query.data,
      elements: buildElements(query.data),
      fileCount: query.data.files.length,
      symbolCount: query.data.symbols.length,
      edgeCount: query.data.edges.length,
      truncated: query.data.truncated,
      rca: rcaQuery.data ?? null,
    };
  }, [query.data, rcaQuery.data]);

  return { query, data };
}
