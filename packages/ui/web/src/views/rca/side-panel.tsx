/**
 * Right column of the RCA Evidence Board: code excerpt + commits-in-scope
 * for the currently-selected candidate.
 *
 * - Pulls the file source via the existing `/api/session/:id/source/*` route
 *   and slices a window around `candidate.line`. Lines inside the candidate's
 *   span (`startLine .. endLine`, inferred from the symbol's recorded line
 *   plus a generous tail) get the halo-red "lit" treatment.
 * - Syntax highlighting is a small regex pass — keywords, strings, numbers,
 *   comments, and call-site identifiers. We deliberately avoid pulling in a
 *   heavyweight tokenizer for what's effectively a 30-line excerpt.
 * - When no source is available (no repoRoot, fetch failed, file missing),
 *   we render a quiet placeholder citing the file:line so the user can grep
 *   themselves. We never invent fake source.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CausalCandidate } from "code-graph-rca";
import type { SourceResponse } from "@shared/api";
import { api } from "../../api/client.ts";

interface Props {
  sessionId: string;
  selectedSymbol: { name: string; file: string | null; line: number | null } | null;
  candidate: CausalCandidate | null;
}

const WINDOW_BEFORE = 4;
const WINDOW_AFTER = 30;

export function SidePanel({ sessionId, selectedSymbol, candidate }: Props) {
  if (!selectedSymbol) {
    return (
      <div className="rca-right">
        <div className="rca-side-empty">
          Select a candidate from the dossiers to inspect its code excerpt and commits.
        </div>
      </div>
    );
  }

  const file = selectedSymbol.file ?? candidate?.file ?? null;
  const line = selectedSymbol.line ?? candidate?.line ?? null;
  const isAnchor = candidate?.role === "anchor";

  const sourceQ = useQuery<SourceResponse, Error>({
    queryKey: ["source", sessionId, file],
    queryFn: () => {
      if (!file) throw new Error("no file");
      return api.source(sessionId, file);
    },
    enabled: Boolean(file),
    retry: false,
  });

  const excerpt = useMemo(() => {
    if (!sourceQ.data || line == null) return null;
    const lines = sourceQ.data.content.split("\n");
    // Approximate end line: candidate.loc when available, else WINDOW_AFTER.
    const span = candidate?.loc ?? WINDOW_AFTER;
    const start = Math.max(1, line - WINDOW_BEFORE);
    // Cap excerpt at ~40 lines so the right column never floods.
    const litStart = line;
    const litEnd = Math.min(lines.length, line + Math.min(span, WINDOW_AFTER));
    const showEnd = Math.min(lines.length, litEnd);
    const slice = lines.slice(start - 1, showEnd).map((text, i) => ({
      lineNo: start + i,
      text,
      lit: start + i >= litStart && start + i <= litStart + 3,
    }));
    return { slice, litStart, litEnd };
  }, [sourceQ.data, line, candidate?.loc]);

  return (
    <div className="rca-right">
      <div className="rca-right-head">
        <div className="label">Inspect · evidence</div>
        <div className={`name${isAnchor ? " hot" : ""}`}>{selectedSymbol.name}</div>
        <div className="file-line">
          {file ? (
            <>
              {file}
              {excerpt
                ? `:${excerpt.litStart}-${excerpt.litEnd}`
                : line != null
                ? `:${line}`
                : ""}
            </>
          ) : (
            "(no file recorded for this symbol)"
          )}
        </div>
      </div>

      <div className="rca-code-pane">
        {!file ? (
          <div className="rca-code-empty">
            This symbol has no file recorded in the indexed graph — it may be
            an out-of-scope dependency or a phantom name surfaced by the scorer.
          </div>
        ) : sourceQ.isPending ? (
          <div className="rca-code-empty">Loading source…</div>
        ) : sourceQ.error ? (
          <div className="rca-code-empty">
            Could not read source from the session repo root.
            <span className="mono">
              {file}
              {line != null ? `:${line}` : ""} · {String(sourceQ.error.message)}
            </span>
          </div>
        ) : !excerpt ? (
          <div className="rca-code-empty">
            No anchor line for this symbol — open the file directly to inspect it.
            <span className="mono">{file}</span>
          </div>
        ) : (
          <pre className="rca-code">
            {excerpt.slice.map(({ lineNo, text, lit }) => (
              <span key={lineNo} className={`row${lit ? " lit" : ""}`}>
                <span className="ln">{lineNo}</span>
                {highlight(text, sourceQ.data.language)}
                {"\n"}
              </span>
            ))}
          </pre>
        )}
      </div>

      {candidate && candidate.recentChanges.length > 0 && (
        <div className="rca-commits">
          <div className="label">
            Recent commits in scope · {candidate.recentChanges.length}
          </div>
          {candidate.recentChanges.slice(0, 6).map((rc) => (
            <div key={rc.commit} className="rca-commit">
              <span className="sha">{rc.commit.slice(0, 7)}</span>
              <span className="subj">{rc.subject}</span>
              <span className="age">{rc.daysAgo}d</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Lightweight regex highlighter.                                      */
/*                                                                     */
/* This is intentionally simple — it covers TS/JS/Python well enough   */
/* for a 30-line excerpt. We do NOT pull in shiki / prismjs / etc      */
/* because the excerpt is small, the highlighting is cosmetic, and     */
/* avoiding the dep keeps the bundle lean. If we ever need accurate    */
/* tokenization (e.g. for a full Monaco-style file pane) shiki is      */
/* already in package.json.                                            */
/* ------------------------------------------------------------------ */

const TS_KEYWORDS = new Set([
  "abstract", "any", "as", "async", "await", "boolean", "break", "case",
  "catch", "class", "const", "continue", "default", "delete", "do", "else",
  "enum", "export", "extends", "false", "finally", "for", "from", "function",
  "if", "implements", "import", "in", "instanceof", "interface", "let", "new",
  "null", "number", "of", "private", "protected", "public", "readonly", "return",
  "static", "string", "super", "switch", "this", "throw", "true", "try", "type",
  "typeof", "undefined", "var", "void", "while", "yield",
]);

const PY_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "False", "finally", "for", "from",
  "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not",
  "or", "pass", "raise", "return", "True", "try", "while", "with", "yield",
]);

interface Tok {
  cls: string | null;
  text: string;
  key: number;
}

/**
 * Token a single source line. Order of regexes matters: comments and
 * strings consume first so identifiers inside them aren't re-tokenized.
 */
function highlight(line: string, lang: SourceResponse["language"]): JSX.Element[] {
  const kws = lang === "python" ? PY_KEYWORDS : TS_KEYWORDS;
  const tokens: Tok[] = [];
  let i = 0;
  let key = 0;
  const push = (cls: string | null, text: string) => {
    if (text.length === 0) return;
    tokens.push({ cls, text, key: key++ });
  };

  while (i < line.length) {
    const rest = line.slice(i);
    // Single-line comment: // for TS, # for python.
    if (
      (lang === "python" && rest.startsWith("#")) ||
      (lang !== "python" && rest.startsWith("//"))
    ) {
      push("com", rest);
      i = line.length;
      break;
    }
    // String literal — handles ", ', and ` until matching quote on the same line.
    if (rest[0] === '"' || rest[0] === "'" || rest[0] === "`") {
      const quote = rest[0];
      let j = 1;
      while (j < rest.length) {
        if (rest[j] === "\\" && j + 1 < rest.length) {
          j += 2;
          continue;
        }
        if (rest[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      push("str", rest.slice(0, j));
      i += j;
      continue;
    }
    // Identifier / keyword
    const idMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
    if (idMatch) {
      const word = idMatch[0];
      // Function-call identifier: ident immediately followed by `(`.
      const after = rest[word.length];
      if (kws.has(word)) {
        push("kw", word);
      } else if (after === "(") {
        push("fn", word);
      } else {
        push(null, word);
      }
      i += word.length;
      continue;
    }
    // Numeric literal
    const numMatch = /^\d[\d_.]*/.exec(rest);
    if (numMatch) {
      push("num-tok", numMatch[0]);
      i += numMatch[0].length;
      continue;
    }
    // Default: a single char of "other". `rest[0]` is non-undefined here
    // because the while-loop guard ensures `i < line.length`.
    push(null, rest[0] ?? "");
    i += 1;
  }

  return tokens.map((t) =>
    t.cls ? (
      <span key={t.key} className={t.cls}>
        {t.text}
      </span>
    ) : (
      <span key={t.key}>{t.text}</span>
    ),
  );
}
