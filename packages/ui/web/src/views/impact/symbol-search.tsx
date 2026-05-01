import { useEffect, useRef, useState } from "react";
import type { Definition } from "code-graph-rca";
import { api } from "../../api/client.ts";
import { cn } from "../../lib/utils.ts";

interface Props {
  sessionId: string;
  value: string;
  onChange: (next: string) => void;
  onPick: (def: Definition) => void;
  onSubmit: () => void;
}

/** Debounced symbol search. Hits `definitionOf` once query length >= 2. */
export function SymbolSearch({ sessionId, value, onChange, onPick, onSubmit }: Props) {
  const [matches, setMatches] = useState<Definition[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    const q = value.trim();
    if (q.length < 2) {
      setMatches([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = window.setTimeout(() => {
      let cancelled = false;
      api
        .query(sessionId, { name: "definitionOf", args: { name: q } })
        .then((res) => {
          if (cancelled) return;
          if (res.name === "definitionOf") {
            setMatches(res.result.slice(0, 12));
          }
        })
        .catch(() => {
          if (!cancelled) setMatches([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, 200);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [value, sessionId]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div ref={containerRef} className="relative w-80">
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            setOpen(false);
            onSubmit();
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="Search symbol…"
        className="w-full rounded border border-border bg-muted px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground"
      />
      {open && value.trim().length >= 2 && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-72 overflow-auto rounded border border-border bg-background shadow">
          {loading && <div className="px-2 py-1 text-xs text-muted-foreground">Searching…</div>}
          {!loading && matches.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">No matches.</div>
          )}
          {matches.map((d, i) => (
            <button
              key={`${d.file}:${d.startLine}:${i}`}
              type="button"
              onClick={() => {
                onPick(d);
                setOpen(false);
              }}
              className={cn(
                "block w-full truncate px-2 py-1 text-left text-xs hover:bg-muted",
                "border-b border-border/40 last:border-b-0",
              )}
            >
              <span className="font-mono text-foreground">{d.name}</span>{" "}
              <span className="text-muted-foreground">
                {d.kind} · {d.file}:{d.startLine}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
