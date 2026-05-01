import type { CausalCandidate } from "code-graph-rca";
import { cn, scoreColor } from "../../lib/utils.ts";

interface Props {
  candidates: CausalCandidate[];
  selectedSymbol: { name: string; file: string | null } | null;
  onSelect: (c: CausalCandidate) => void;
}

export function CandidatesPanel({ candidates, selectedSymbol, onSelect }: Props) {
  if (candidates.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <Header count={0} />
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          No candidates — scope was too small or had no recency signal.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Header count={candidates.length} />
      <ul className="flex-1 overflow-y-auto">
        {candidates.map((c, i) => {
          const isSelected =
            selectedSymbol?.name === c.name && (selectedSymbol?.file ?? null) === (c.file ?? null);
          return (
            <li key={`${c.file ?? "?"}:${c.name}:${i}`}>
              <button
                onClick={() => onSelect(c)}
                className={cn(
                  "flex w-full flex-col gap-1 border-b border-border px-3 py-2 text-left text-sm hover:bg-muted",
                  isSelected && "bg-muted",
                )}
              >
                <div className="flex items-center gap-2">
                  <ScoreBadge score={c.score} />
                  <span className="font-mono font-medium">{c.name}</span>
                  <span className="ml-auto text-xs uppercase text-muted-foreground">{c.role}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>d={c.distance}</span>
                  {c.file && <span className="truncate">{c.file}</span>}
                </div>
                <div className="text-xs leading-snug">{c.rationale}</div>
                {c.recentChanges[0] && (
                  <div className="truncate text-[11px] font-mono text-muted-foreground">
                    {c.recentChanges[0].commit.slice(0, 7)} · {c.recentChanges[0].subject} ·{" "}
                    {c.recentChanges[0].daysAgo}d
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Header({ count }: { count: number }) {
  return (
    <div className="border-b border-border px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground">
      Causal Candidates ({count})
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  return (
    <span
      className="inline-flex h-5 min-w-[2rem] items-center justify-center rounded px-1 font-mono text-xs font-semibold text-slate-900"
      style={{ backgroundColor: scoreColor(score) }}
    >
      {score.toFixed(1)}
    </span>
  );
}
