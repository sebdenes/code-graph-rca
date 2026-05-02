/**
 * Causal-candidate dossier list (left column of the RCA Evidence Board).
 *
 * Each card carries: rank · name · role tag · file:line · LOC · 7-signal radial
 * · italic-serif score · italic rationale · most-recent commit ticker.
 *
 * Selection writes to the shared zustand session store; arrow-key navigation
 * is wired at the list level so up/down moves the selection through the
 * visible dossiers without taking focus off whatever the user clicked last.
 */
import { useEffect, useRef } from "react";
import type { CausalCandidate } from "code-graph-rca";
import { cn } from "../../lib/utils.ts";
import { SignalRadial } from "./signal-radial.tsx";

interface SelectionShape {
  name: string;
  file: string | null;
}

interface Props {
  candidates: CausalCandidate[];
  selectedSymbol: SelectionShape | null;
  /** Anchor's display name, for the head prose. */
  anchorName?: string | null;
  onSelect: (c: CausalCandidate) => void;
}

function isSelected(
  c: CausalCandidate,
  sel: SelectionShape | null,
): boolean {
  if (!sel) return false;
  return sel.name === c.name && (sel.file ?? null) === (c.file ?? null);
}

export function CandidatesPanel({
  candidates,
  selectedSymbol,
  anchorName,
  onSelect,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Arrow-key navigation across the dossier list. Listens at the panel root
  // so the user can move the selection without clicking back into the list.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (candidates.length === 0) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      // Only steer if focus is inside this panel — keeps Graph/Impact happy.
      const root = listRef.current;
      if (!root) return;
      if (!(document.activeElement && root.contains(document.activeElement))) return;
      e.preventDefault();
      const idx = candidates.findIndex((c) => isSelected(c, selectedSymbol));
      const next =
        e.key === "ArrowDown"
          ? Math.min(candidates.length - 1, idx < 0 ? 0 : idx + 1)
          : Math.max(0, idx < 0 ? 0 : idx - 1);
      const target = candidates[next];
      if (target) onSelect(target);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [candidates, selectedSymbol, onSelect]);

  if (candidates.length === 0) {
    return (
      <div className="rca-dossiers" ref={listRef}>
        <div className="rca-dossiers-head">
          <div className="label">Causal candidates · 0</div>
        </div>
        <div className="rca-empty-prose">
          No candidates — scope was too small or had no recency signal.
        </div>
      </div>
    );
  }

  // The empty-list branch above guarantees `candidates.length >= 1`, so the
  // fallback to candidates[0] is safe even though TS can't narrow that.
  const anchor = candidates.find((c) => c.role === "anchor") ?? candidates[0]!;
  const anchorDisplay = anchorName ?? anchor.name;
  const anchorAge = anchor.recentChanges[0]?.daysAgo;
  const anchorSha = anchor.recentChanges[0]?.commit.slice(0, 7);

  return (
    <div className="rca-dossiers" ref={listRef}>
      <div className="rca-dossiers-head">
        <div className="label">Causal candidates · {candidates.length}</div>
        <div className="anchor-line">
          The most likely cause sits in <span className="name">{anchorDisplay}</span>
          {anchorAge !== undefined && (
            <>
              {" "}— anchor of the failure neighborhood, modified <em>{anchorAge}d ago</em>
              {anchorSha && (
                <>
                  {" "}in commit <span className="file">{anchorSha}</span>
                </>
              )}
            </>
          )}
          .
        </div>
      </div>
      {candidates.map((c, i) => (
        <DossierCard
          key={`${c.file ?? "?"}:${c.name}:${i}`}
          rank={i + 1}
          candidate={c}
          selected={isSelected(c, selectedSymbol)}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

interface CardProps {
  rank: number;
  candidate: CausalCandidate;
  selected: boolean;
  onSelect: (c: CausalCandidate) => void;
}

function DossierCard({ rank, candidate, selected, onSelect }: CardProps) {
  const c = candidate;
  const isAnchor = c.role === "anchor";
  const roleTag =
    c.role === "anchor"
      ? "Anchor"
      : c.role === "caller"
      ? `Caller · d=${c.distance}`
      : `Callee · d=${c.distance}`;
  const scoreClass = isAnchor ? "hot" : c.score < 1.4 ? "dim" : "";
  const fileLine =
    c.file && c.line ? `${c.file}:${c.line}` : c.file ?? "(unscoped)";
  const loc = c.loc ? `${c.loc} LOC` : null;

  // Recent commit ticker — first entry only, matching the mockup.
  const ticker = c.recentChanges[0] ?? null;

  return (
    <button
      type="button"
      className={cn("rca-dossier", selected && "selected")}
      onClick={() => onSelect(c)}
      aria-pressed={selected}
    >
      <div className="rca-dossier-head">
        <div className="rca-dossier-rank">{String(rank).padStart(2, "0")}</div>
        <div className={cn("rca-dossier-name", isAnchor && "anchor")}>{c.name}</div>
        <div className="rca-dossier-role">{roleTag}</div>
      </div>
      <div className="rca-dossier-loc">
        {fileLine}
        {loc && <> · {loc}</>}
      </div>

      <div className="rca-signal-row">
        <SignalRadial signals={c.signals} isAnchor={isAnchor} />
        <div className="rca-score-block">
          <div className={cn("num", scoreClass)}>{c.score.toFixed(1)}</div>
          <div className="label">score</div>
        </div>
      </div>

      <div className="rca-rationale">
        {isAnchor && <span className="em">Anchor.</span>}{" "}
        {c.rationale}
      </div>

      {ticker && (
        <div className="rca-ticker">
          <span className="sha">{ticker.commit.slice(0, 7)}</span>
          <span className="age">{ticker.daysAgo}d</span>
          <span className="subj">{ticker.subject}</span>
        </div>
      )}
    </button>
  );
}
