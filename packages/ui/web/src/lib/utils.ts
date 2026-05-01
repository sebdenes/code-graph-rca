import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Map a causal score (0..10+) to a color token. */
export function scoreColor(score: number): string {
  if (score >= 8) return "var(--score-1, #dc2626)";
  if (score >= 6) return "var(--score-2, #f97316)";
  if (score >= 4) return "var(--score-3, #eab308)";
  if (score >= 2) return "var(--score-4, #84cc16)";
  return "var(--score-5, #22d3ee)";
}

/** Confidence (0..1) → edge width in px. */
export function confidenceToWidth(c: number): number {
  return Math.max(1, Math.min(4, Math.round(c * 4)));
}
