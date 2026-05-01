/**
 * Pure transform from `GraphResponse` to a flat list of cytoscape elements.
 *
 * We synthesize Folder + File nodes from the file paths the server returned
 * (the API doesn't carry folder rows), and emit CONTAINS edges to assemble
 * the directory tree. Symbols hang off their owning file via CONTAINS too.
 * CALLS / EXTENDS / IMPLEMENTS edges come straight from `graph.edges`, with
 * one phantom node per unique unresolved name (per source) so the canvas
 * doesn't sprout duplicate ghosts.
 */
import type { ElementDefinition } from "cytoscape";
import type { GraphResponse, GraphSymbolNode } from "@shared/api";
import { KIND_COLORS, type NodeKind } from "./styles.ts";

export interface NodePayload {
  id: string;
  kind: NodeKind;
  name: string;
  label: string;
  /** Absolute file path if the node is anchored to a file, else null. */
  file: string | null;
  /** 1-based line for symbols; null for folders/files/phantoms. */
  line: number | null;
  /** Display size in px (clamped). */
  size: number;
  /** Color hex (mirrors `kind` but stored on data so the stylesheet can read it). */
  color: string;
  /** Internal symbol id when this node represents a real symbol; null otherwise. */
  symbolId: number | null;
}

const FOLDER_PREFIX = "fld:";
const FILE_PREFIX = "f:";
const SYM_PREFIX = "s:";
const PHANTOM_PREFIX = "p:";

export function folderId(path: string): string {
  return `${FOLDER_PREFIX}${path}`;
}
export function fileId(id: number): string {
  return `${FILE_PREFIX}${id}`;
}
export function symbolId(s: GraphSymbolNode): string {
  return `${SYM_PREFIX}${s.id}`;
}
export function phantomId(_fromSymbolId: number, _kind: string, toName: string): string {
  // Dedup phantoms GLOBALLY by name. With ~2600 unresolved edges per session,
  // a per-source dedup produces ~1000 phantom nodes (one per call site of
  // `get`, `append`, `len`, etc.) and blows up cytoscape render time. Across
  // the whole graph, those collapse to ~80 unique names. We sacrifice the
  // per-caller distinction (which the LLM already gets from edges) for a
  // ~10× rendering win.
  return `${PHANTOM_PREFIX}${toName}`;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function clampSize(loc: number, min = 4, max = 8): number {
  if (!Number.isFinite(loc) || loc <= 0) return min;
  // log scale; LOC ranges from 1 to a few thousand
  const v = Math.log10(loc + 1) * 2;
  return Math.max(min, Math.min(max, Math.round(min + v)));
}

/** Confidence → "solid" | "dashed" | "dotted" weave class. */
function weaveFor(confidence: number | null | undefined): "solid" | "dashed" | "dotted" {
  const c = typeof confidence === "number" ? confidence : 1;
  if (c >= 0.9) return "solid";
  if (c >= 0.7) return "dashed";
  return "dotted";
}

export function buildElements(graph: GraphResponse): ElementDefinition[] {
  const els: ElementDefinition[] = [];
  const folderSeen = new Set<string>();

  // 1) folders — walk every file path, register every prefix as a folder.
  for (const f of graph.files) {
    const parts = f.path.split("/");
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (seg === undefined) continue;
      const next = cur === "" ? seg : `${cur}/${seg}`;
      if (!folderSeen.has(next)) {
        folderSeen.add(next);
        const data: NodePayload = {
          id: folderId(next),
          kind: "folder",
          name: seg,
          label: seg,
          file: null,
          line: null,
          size: 7,
          color: KIND_COLORS.folder,
          symbolId: null,
        };
        els.push({ group: "nodes", data: data as unknown as Record<string, unknown> });
      }
      cur = next;
    }
  }

  // CONTAINS edges between folders.
  for (const folderPath of folderSeen) {
    const parent = dirname(folderPath);
    if (parent !== "" && folderSeen.has(parent)) {
      els.push({
        group: "edges",
        data: {
          id: `e:${folderId(parent)}->${folderId(folderPath)}`,
          source: folderId(parent),
          target: folderId(folderPath),
          ekind: "CONTAINS",
        },
      });
    }
  }

  // 2) files
  for (const f of graph.files) {
    const data: NodePayload = {
      id: fileId(f.id),
      kind: "file",
      name: basename(f.path),
      label: basename(f.path),
      file: f.path,
      line: null,
      size: clampSize(f.loc, 5, 8),
      color: KIND_COLORS.file,
      symbolId: null,
    };
    els.push({ group: "nodes", data: data as unknown as Record<string, unknown> });

    const parent = dirname(f.path);
    if (parent !== "" && folderSeen.has(parent)) {
      els.push({
        group: "edges",
        data: {
          id: `e:${folderId(parent)}->${fileId(f.id)}`,
          source: folderId(parent),
          target: fileId(f.id),
          ekind: "CONTAINS",
        },
      });
    }
  }

  // 3) symbols
  const filesById = new Map(graph.files.map((f) => [f.id, f]));
  for (const s of graph.symbols) {
    const f = filesById.get(s.fileId);
    const loc = Math.max(1, s.endLine - s.startLine + 1);
    const data: NodePayload = {
      id: symbolId(s),
      kind: s.kind as NodeKind,
      name: s.name,
      label: s.name,
      file: f?.path ?? null,
      line: s.startLine,
      size: clampSize(loc, 4, 8),
      color: KIND_COLORS[s.kind as NodeKind] ?? KIND_COLORS.function,
      symbolId: s.id,
    };
    els.push({ group: "nodes", data: data as unknown as Record<string, unknown> });

    if (f) {
      els.push({
        group: "edges",
        data: {
          id: `e:${fileId(f.id)}->${symbolId(s)}`,
          source: fileId(f.id),
          target: symbolId(s),
          ekind: "CONTAINS",
        },
      });
    }
  }

  // 4) phantoms + CALLS/EXTENDS/IMPLEMENTS edges
  const symIdToNode = new Map(graph.symbols.map((s) => [s.id, symbolId(s)]));
  const phantomSeen = new Set<string>();
  let edgeIdx = 0;
  for (const e of graph.edges) {
    const source = symIdToNode.get(e.fromSymbolId);
    if (!source) continue;
    let target: string;
    if (e.toSymbolId != null) {
      const t = symIdToNode.get(e.toSymbolId);
      if (!t) continue;
      target = t;
    } else {
      const pid = phantomId(e.fromSymbolId, e.kind, e.toName);
      if (!phantomSeen.has(pid)) {
        phantomSeen.add(pid);
        const data: NodePayload = {
          id: pid,
          kind: "phantom",
          name: e.toName,
          label: e.toName,
          file: null,
          line: null,
          size: 4,
          color: KIND_COLORS.phantom,
          symbolId: null,
        };
        els.push({ group: "nodes", data: data as unknown as Record<string, unknown> });
      }
      target = pid;
    }
    els.push({
      group: "edges",
      data: {
        id: `c:${edgeIdx++}`,
        source,
        target,
        ekind: e.kind,
        weave: weaveFor(e.confidence),
        confidence: e.confidence,
      },
    });
  }

  return els;
}
