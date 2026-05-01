import type { editor } from "monaco-editor";

export interface CallerAnnotation {
  name: string;
  file: string;
  line: number;
}

export interface CalleeAnnotation {
  name: string;
  file: string | null;
  line: number | null;
  resolved: boolean;
}

export interface BuildZoneOptions {
  /** 1-based line where the symbol body starts. Callers are drawn above this. */
  symbolStart: number;
  /** 1-based line where the symbol body ends. Callees are drawn just below. */
  symbolEnd: number;
  callers: readonly CallerAnnotation[];
  callees: readonly CalleeAnnotation[];
  /** Click handler for caller/callee names. */
  onNavigate?: (file: string, line: number) => void;
}

export interface BuiltViewZone {
  zone: editor.IViewZone;
  cleanup: () => void;
}

function makeRow(label: string, items: ReadonlyArray<{ text: string; target: { file: string; line: number } | null }>, onNavigate?: (file: string, line: number) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "cgrca-zone-row";
  const tag = document.createElement("span");
  tag.className = "cgrca-zone-tag";
  tag.textContent = `${label} (${items.length})`;
  row.appendChild(tag);
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (!it) continue;
    if (it.target && onNavigate) {
      const a = document.createElement("button");
      a.type = "button";
      a.className = "cgrca-zone-link";
      a.textContent = it.text;
      const tgt = it.target;
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onNavigate(tgt.file, tgt.line);
      });
      row.appendChild(a);
    } else {
      const span = document.createElement("span");
      span.className = it.target ? "cgrca-zone-link" : "cgrca-zone-link cgrca-zone-link-disabled";
      span.textContent = it.text;
      row.appendChild(span);
    }
    if (i < items.length - 1) {
      const sep = document.createElement("span");
      sep.className = "cgrca-zone-sep";
      sep.textContent = ",";
      row.appendChild(sep);
    }
  }
  return row;
}

/**
 * Build Monaco view zones for caller/callee annotations. Returns 0–2 zones:
 *  - one "callers" zone above `symbolStart` (afterLineNumber = start - 1)
 *  - one "callees" zone after `symbolEnd`
 * Each zone owns a DOM node — call cleanup() to detach handlers if the zone
 * is removed before the editor disposes the node.
 */
export function buildViewZones(opts: BuildZoneOptions): BuiltViewZone[] {
  const { symbolStart, symbolEnd, callers, callees, onNavigate } = opts;
  const out: BuiltViewZone[] = [];

  if (callers.length > 0) {
    const dom = document.createElement("div");
    dom.className = "cgrca-zone cgrca-zone-callers";
    dom.appendChild(
      makeRow(
        "callers",
        callers.map((c) => ({ text: c.name, target: { file: c.file, line: c.line } })),
        onNavigate,
      ),
    );
    out.push({
      zone: {
        afterLineNumber: Math.max(0, symbolStart - 1),
        heightInLines: 1,
        domNode: dom,
      },
      cleanup: () => {
        // Listeners auto-GC with the DOM node; nothing extra to do.
      },
    });
  }

  if (callees.length > 0) {
    const dom = document.createElement("div");
    dom.className = "cgrca-zone cgrca-zone-callees";
    dom.appendChild(
      makeRow(
        "callees",
        callees.map((c) => ({
          text: c.resolved ? c.name : `${c.name} (unresolved)`,
          target: c.file && c.line ? { file: c.file, line: c.line } : null,
        })),
        onNavigate,
      ),
    );
    out.push({
      zone: {
        afterLineNumber: Math.max(0, symbolEnd),
        heightInLines: 1,
        domNode: dom,
      },
      cleanup: () => {
        // No-op for v1.
      },
    });
  }

  return out;
}
