import type { editor } from "monaco-editor";
import type { BlameLine } from "@shared/api";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bucket a blame line by recency relative to `now`. */
function recencyClass(dateIso: string, now: number): string {
  const t = Date.parse(dateIso);
  if (Number.isNaN(t)) return "cgrca-blame-old";
  const ageDays = (now - t) / DAY_MS;
  if (ageDays < 7) return "cgrca-blame-hot";
  if (ageDays < 30) return "cgrca-blame-warm";
  if (ageDays < 90) return "cgrca-blame-tepid";
  return "cgrca-blame-old";
}

/**
 * Build Monaco gutter decorations from blame data. Each line gets a colored bar
 * (linesDecorationsClassName) plus a hover tooltip showing the short SHA,
 * author, date, and subject.
 */
export function buildBlameDecorations(
  monaco: typeof import("monaco-editor"),
  blame: readonly BlameLine[],
  now: number = Date.now(),
): editor.IModelDeltaDecoration[] {
  const decorations: editor.IModelDeltaDecoration[] = [];
  for (const line of blame) {
    if (!line || line.line < 1) continue;
    const short = line.commit ? line.commit.slice(0, 7) : "";
    const hover = `**${short}** \`${line.author}\` _${line.date}_  \n${line.subject}`;
    decorations.push({
      range: new monaco.Range(line.line, 1, line.line, 1),
      options: {
        isWholeLine: false,
        linesDecorationsClassName: `cgrca-blame ${recencyClass(line.date, now)}`,
        hoverMessage: { value: hover },
      },
    });
  }
  return decorations;
}
