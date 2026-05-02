import { useCallback, useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor";

export interface UseMonacoApi {
  /** The mounted editor (null until onMount fires). */
  editor: editor.IStandaloneCodeEditor | null;
  /** Callback to wire into the React wrapper's `onMount`. */
  onMount: (ed: editor.IStandaloneCodeEditor) => void;
  /** Container ref for ResizeObserver wiring. */
  container: React.RefObject<HTMLDivElement | null>;
  /** Scroll the editor so `line` (1-based) is centered. */
  revealLine: (line: number) => void;
  /** Replace all view zones with `zones`. Old zone IDs are removed. */
  setViewZones: (zones: editor.IViewZone[]) => void;
  /** Replace the active decorations with `decs`. */
  setDecorations: (decs: editor.IModelDeltaDecoration[]) => void;
}

/**
 * Thin wrapper around the Monaco React Editor that exposes imperative helpers
 * we need (reveal, view zones, decorations) and ties layout to a ResizeObserver
 * on the container — Monaco's `automaticLayout: true` covers most cases but
 * we also nudge it on container resize.
 */
export function useMonacoEditor(): UseMonacoApi {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [editorState, setEditorState] = useState<editor.IStandaloneCodeEditor | null>(null);

  const decorationCollectionRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  const zoneIdsRef = useRef<string[]>([]);

  const onMount = useCallback((ed: editor.IStandaloneCodeEditor) => {
    editorRef.current = ed;
    setEditorState(ed);
  }, []);

  // Tie layout to the container size so the editor reflows when the parent does.
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const ro = new ResizeObserver(() => {
      const ed = editorRef.current;
      if (ed) ed.layout();
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      const ed = editorRef.current;
      if (ed && zoneIdsRef.current.length > 0) {
        ed.changeViewZones((accessor) => {
          for (const id of zoneIdsRef.current) accessor.removeZone(id);
        });
        zoneIdsRef.current = [];
      }
      decorationCollectionRef.current?.clear();
      decorationCollectionRef.current = null;
    };
  }, []);

  const revealLine = useCallback((line: number) => {
    const ed = editorRef.current;
    if (!ed || line < 1) return;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
  }, []);

  const setViewZones = useCallback((zones: editor.IViewZone[]) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.changeViewZones((accessor) => {
      for (const id of zoneIdsRef.current) accessor.removeZone(id);
      zoneIdsRef.current = [];
      for (const zone of zones) {
        zoneIdsRef.current.push(accessor.addZone(zone));
      }
    });
  }, []);

  const setDecorations = useCallback((decs: editor.IModelDeltaDecoration[]) => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!decorationCollectionRef.current) {
      decorationCollectionRef.current = ed.createDecorationsCollection(decs);
    } else {
      decorationCollectionRef.current.set(decs);
    }
  }, []);

  return {
    editor: editorState,
    onMount,
    container,
    revealLine,
    setViewZones,
    setDecorations,
  };
}
