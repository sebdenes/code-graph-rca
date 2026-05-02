import { useEffect, useMemo, type JSX } from "react";
import Editor from "@monaco-editor/react";
import { useQueries } from "@tanstack/react-query";
import type { editor } from "monaco-editor";
import * as monaco from "monaco-editor";
import { api } from "@/api/client.ts";
import { cn } from "@/lib/utils.ts";
import type { BlameResponse, SourceResponse } from "@shared/api";
import { installMonacoEnv } from "./monaco-env.ts";
import { useMonacoEditor } from "./use-monaco.ts";
import { buildBlameDecorations } from "./blame-gutter.ts";
import { buildViewZones, type CallerAnnotation, type CalleeAnnotation } from "./view-zones.ts";

installMonacoEnv();

export interface CodePaneAnnotations {
  callers: CallerAnnotation[];
  callees: CalleeAnnotation[];
}

export interface CodePaneProps {
  sessionId: string;
  /** When null/undefined the pane shows a placeholder. */
  file: string | null;
  /** Line to scroll into focus (1-based). */
  line?: number | null;
  /** Inline annotations: callers (rendered above the symbol) and callees (rendered below). */
  annotations?: CodePaneAnnotations;
  /** Optional ranges to highlight (e.g. the symbol's full body). */
  highlightRange?: { start: number; end: number } | null;
  /** Click handler when a caller/callee link is activated. */
  onNavigate?: (file: string, line: number) => void;
  className?: string;
}

function languageId(lang: SourceResponse["language"] | undefined): string {
  if (lang === "typescript") return "typescript";
  if (lang === "python") return "python";
  return "plaintext";
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("404 ");
}

const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
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

export function CodePane(props: CodePaneProps): JSX.Element {
  const { sessionId, file, line, annotations, highlightRange, onNavigate, className } = props;
  const monacoApi = useMonacoEditor();

  const [sourceQ, blameQ] = useQueries({
    queries: [
      {
        queryKey: ["source", sessionId, file],
        queryFn: () => api.source(sessionId, file ?? ""),
        enabled: Boolean(file),
        retry: false,
      },
      {
        queryKey: ["blame", sessionId, file],
        queryFn: () => api.blame(sessionId, file ?? ""),
        enabled: Boolean(file),
        retry: false,
      },
    ],
  });

  const source = sourceQ.data as SourceResponse | undefined;
  const blame = blameQ.data as BlameResponse | undefined;

  const language = languageId(source?.language);

  // Apply blame + highlight decorations whenever the inputs change.
  useEffect(() => {
    if (!monacoApi.editor) return;
    const decs: editor.IModelDeltaDecoration[] = [];
    if (blame?.lines && blame.lines.length > 0) {
      decs.push(...buildBlameDecorations(monaco, blame.lines));
    }
    if (highlightRange && highlightRange.end >= highlightRange.start) {
      decs.push({
        range: new monaco.Range(highlightRange.start, 1, highlightRange.end, 1),
        options: {
          isWholeLine: true,
          className: "cgrca-symbol-highlight",
          marginClassName: "cgrca-symbol-highlight-gutter",
        },
      });
    }
    monacoApi.setDecorations(decs);
  }, [monacoApi, monacoApi.editor, blame, highlightRange]);

  // Apply view zones (caller/callee annotations).
  useEffect(() => {
    if (!monacoApi.editor) return;
    if (!annotations || (annotations.callers.length === 0 && annotations.callees.length === 0)) {
      monacoApi.setViewZones([]);
      return;
    }
    const start = highlightRange?.start ?? line ?? 1;
    const end = highlightRange?.end ?? start;
    const built = buildViewZones({
      symbolStart: start,
      symbolEnd: end,
      callers: annotations.callers,
      callees: annotations.callees,
      ...(onNavigate ? { onNavigate } : {}),
    });
    monacoApi.setViewZones(built.map((b) => b.zone));
  }, [monacoApi, monacoApi.editor, annotations, highlightRange, line, onNavigate]);

  // Reveal the focused line whenever it (or the source) changes.
  useEffect(() => {
    if (!monacoApi.editor || !source) return;
    if (typeof line === "number" && line > 0) {
      monacoApi.revealLine(line);
    }
  }, [monacoApi, monacoApi.editor, source, line]);

  // Empty state.
  if (!file) {
    return (
      <div className={cn("flex h-full w-full items-center justify-center text-muted-foreground", className)}>
        Select a node to preview source.
      </div>
    );
  }

  // Source 404 → friendly message (blame errors are silent).
  if (sourceQ.isError && isNotFound(sourceQ.error)) {
    return (
      <div className={cn("flex h-full w-full items-center justify-center text-muted-foreground", className)}>
        File not in indexed scope.
      </div>
    );
  }

  const showLoading = sourceQ.isPending && !source;

  // Stable model path — keeps view state across line changes within the same file.
  const modelPath = useMemo(() => `inmemory://session/${sessionId}/${file ?? ""}`, [sessionId, file]);

  return (
    <div ref={monacoApi.container} className={cn("relative h-full w-full bg-[#1e1e1e]", className)}>
      <Editor
        height="100%"
        width="100%"
        theme="vs-dark"
        language={language}
        path={modelPath}
        value={source?.content ?? ""}
        options={EDITOR_OPTIONS}
        onMount={monacoApi.onMount}
        loading={<div className="text-xs text-muted-foreground">Loading source…</div>}
      />
      {showLoading ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 px-3 py-1 text-[11px] text-muted-foreground/80">
          Loading source…
        </div>
      ) : null}
    </div>
  );
}

export default CodePane;
