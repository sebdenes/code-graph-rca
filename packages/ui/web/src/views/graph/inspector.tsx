/**
 * Constellation Inspector — single-focus reader, not an IDE.
 *
 * Replaces the previous multi-pane stack. One Monaco editor at a time;
 * pinned files appear as small breadcrumb tabs at the top (basename + a
 * kind-color dot + close). Click a tab to switch. Capacity is 6 tabs;
 * older tabs are evicted LRU by the parent.
 *
 * Footer carries a tiny lineage breadcrumb: subsystem · file · parent · symbol.
 *
 * Empty state: a centered call-to-action with a faint constellation sketch
 * (CSS pseudo-element in graph.css) — keeps the visual language consistent
 * even when nothing is pinned.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import type { editor as MonacoEditor } from "monaco-editor";
import * as monaco from "monaco-editor";
import { api } from "@/api/client.ts";
import { installMonacoEnv } from "@/components/code/monaco-env.ts";
import { KIND_COLORS, type NodeKind } from "./styles.ts";

installMonacoEnv();

const EDITOR_OPTIONS: MonacoEditor.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  lineNumbers: "on",
  glyphMargin: false,
  folding: false,
  renderLineHighlight: "none",
  smoothScrolling: true,
  wordWrap: "off",
};

function languageFor(path: string): string {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".tsx") || path.endsWith(".ts")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function dirSegment(p: string): string {
  const i = p.lastIndexOf("/");
  if (i === -1) return "";
  const dir = p.slice(0, i);
  const j = dir.lastIndexOf("/");
  return j === -1 ? dir : dir.slice(j + 1);
}

export interface PinnedFile {
  /** Stable id (cytoscape node id of the symbol that opened it). */
  id: string;
  path: string;
  line: number | null;
  highlightRange: { start: number; end: number } | null;
  kind: NodeKind;
  /** Display name of the symbol that anchored this pin. */
  symbolName?: string;
  /** Owning class/parent if any — used for the lineage breadcrumb. */
  parentName?: string | null;
}

export interface InspectorProps {
  sessionId: string;
  pins: PinnedFile[];
  onClose: (id: string) => void;
}

export function Inspector(props: InspectorProps) {
  const { sessionId, pins, onClose } = props;

  // Active tab — defaults to the most recently pinned (last in the array,
  // since the parent appends LRU-style).
  const [activeId, setActiveId] = useState<string | null>(null);

  // Keep activeId valid as pins change. If the active pin was closed, fall
  // back to the most recent. If the user pinned a new file, focus it.
  useEffect(() => {
    if (pins.length === 0) {
      setActiveId(null);
      return;
    }
    const stillThere = pins.some((p) => p.id === activeId);
    if (!stillThere) {
      setActiveId(pins[pins.length - 1]!.id);
    } else {
      // If the latest pin changed (new tab pushed), prefer it.
      const last = pins[pins.length - 1]!;
      if (last.id !== activeId) {
        // Only auto-switch when the latest pin was added by the parent
        // (heuristic: it's a new id we haven't seen). We can't tell that
        // from props alone, but switching to last is what the user expects
        // 95% of the time after clicking a graph node, so do it.
        setActiveId(last.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins.map((p) => p.id).join("|")]);

  if (pins.length === 0) {
    return (
      <div className="inspector-empty flex h-full w-full items-center justify-center p-6 text-center">
        <div className="constellation-sketch flex flex-col items-center gap-3 text-[12px] text-zinc-500">
          <div className="constellation-sketch-art" aria-hidden />
          <div className="font-mono">Select a node to read its source.</div>
        </div>
      </div>
    );
  }

  const active = pins.find((p) => p.id === activeId) ?? pins[pins.length - 1]!;

  return (
    <div className="inspector-shell flex h-full w-full flex-col">
      <TabStrip pins={pins} activeId={active.id} onActivate={setActiveId} onClose={onClose} />
      <div className="relative flex-1 overflow-hidden">
        <Reader sessionId={sessionId} pin={active} />
      </div>
      <Footer pin={active} />
    </div>
  );
}

interface TabStripProps {
  pins: PinnedFile[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

function TabStrip(props: TabStripProps) {
  const { pins, activeId, onActivate, onClose } = props;
  return (
    <div className="inspector-tabs flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-1.5">
      {pins.map((p) => {
        const active = p.id === activeId;
        return (
          <div
            key={p.id}
            className={
              "inspector-tab flex shrink-0 items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] transition" +
              (active ? " inspector-tab--active" : "")
            }
            onClick={() => onActivate(p.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onActivate(p.id);
            }}
            title={p.path}
          >
            <span
              className="kind-dot"
              style={{ background: KIND_COLORS[p.kind] ?? KIND_COLORS.file }}
              aria-hidden
            />
            <span className="truncate text-zinc-200" style={{ maxWidth: 140 }}>
              {basename(p.path)}
            </span>
            <button
              type="button"
              className="tab-close ml-1 text-zinc-500 hover:text-zinc-200"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onClose(p.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

interface ReaderProps {
  sessionId: string;
  pin: PinnedFile;
}

function Reader(props: ReaderProps) {
  const { sessionId, pin } = props;
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const sourceQ = useQuery({
    queryKey: ["source", sessionId, pin.path],
    queryFn: () => api.source(sessionId, pin.path),
    retry: false,
  });

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    applyDecorations();
    revealLine();
  };

  const applyDecorations = () => {
    const ed = editorRef.current;
    if (!ed) return;
    const decs: MonacoEditor.IModelDeltaDecoration[] = [];
    if (pin.line !== null && pin.line > 0) {
      // 2px left border + subtle background tint on the symbol's start line.
      decs.push({
        range: new monaco.Range(pin.line, 1, pin.line, 1),
        options: {
          isWholeLine: true,
          className: "constellation-startline",
          linesDecorationsClassName: "constellation-startline-glyph",
        },
      });
    }
    if (pin.highlightRange && pin.highlightRange.end >= pin.highlightRange.start) {
      decs.push({
        range: new monaco.Range(pin.highlightRange.start, 1, pin.highlightRange.end, 1),
        options: {
          isWholeLine: true,
          className: "constellation-symbolrange",
        },
      });
    }
    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, decs);
  };

  const revealLine = () => {
    const ed = editorRef.current;
    if (!ed) return;
    if (pin.line !== null && pin.line > 0) {
      ed.revealLineInCenter(pin.line);
      ed.setPosition({ lineNumber: pin.line, column: 1 });
    }
  };

  useEffect(() => {
    applyDecorations();
    revealLine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin.line, pin.highlightRange?.start, pin.highlightRange?.end, pin.path, sourceQ.data]);

  const lang = useMemo(() => languageFor(pin.path), [pin.path]);
  const modelPath = useMemo(
    () => `inmemory://session/${sessionId}/${pin.path}`,
    [sessionId, pin.path],
  );

  if (sourceQ.isError) {
    return (
      <div className="flex h-full w-full items-center justify-center text-[11px] text-zinc-500">
        File not in indexed scope.
      </div>
    );
  }

  return (
    <Editor
      height="100%"
      width="100%"
      theme="vs-dark"
      language={lang}
      path={modelPath}
      value={sourceQ.data?.content ?? ""}
      options={EDITOR_OPTIONS}
      onMount={onMount}
      loading={<div className="text-[11px] text-zinc-500">Loading…</div>}
    />
  );
}

function Footer(props: { pin: PinnedFile }) {
  const { pin } = props;
  // Crude subsystem inference from the path's first segment — the API
  // doesn't expose subsystem on a per-pin basis here, but the first
  // path segment is the conventional grouping.
  const segs = pin.path.split("/").filter((s) => s !== "");
  const subsystem = segs[0] ?? "";
  const fileName = basename(pin.path);
  const dir = dirSegment(pin.path);
  const parent = pin.parentName ?? null;
  const symbol = pin.symbolName ?? null;

  return (
    <div className="inspector-footer flex shrink-0 items-center gap-1 overflow-hidden px-3 py-1 font-mono text-[10px] text-zinc-500">
      {subsystem ? <span>{subsystem}</span> : null}
      {dir && dir !== subsystem ? (
        <>
          <span className="opacity-50">·</span>
          <span>{dir}</span>
        </>
      ) : null}
      <span className="opacity-50">·</span>
      <span className="text-zinc-300">{fileName}</span>
      {parent ? (
        <>
          <span className="opacity-50">·</span>
          <span>{parent}</span>
        </>
      ) : null}
      {symbol ? (
        <>
          <span className="opacity-50">·</span>
          <span className="text-cyan-300/80">{symbol}</span>
        </>
      ) : null}
      {pin.line !== null ? (
        <span className="ml-auto opacity-70">L{pin.line}</span>
      ) : null}
    </div>
  );
}
