import type { CausalCandidate } from "../types.js";

interface QueryEntry {
  name: string;
  result: unknown;
}

const SECTION_TITLES: Record<string, string> = {
  definitionOf: "Definition",
  callersOf: "Callers (depth 2)",
  calleesOf: "Callees (depth 1)",
  symbolsInFile: "Symbols in seed file",
  recentlyChangedNear: "Recently changed (last 90 days)",
};

function isEmpty(name: string, result: unknown): boolean {
  if (result === null || result === undefined) return true;
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (name === "callersOf" && Array.isArray(r["callers"])) {
      return (r["callers"] as unknown[]).length === 0;
    }
    if (name === "calleesOf" && Array.isArray(r["callees"])) {
      return (r["callees"] as unknown[]).length === 0;
    }
  }
  return false;
}

function renderSection(title: string, result: unknown, empty: boolean): string {
  if (empty) {
    return `### ${title}\n\n_(none)_`;
  }
  return `### ${title}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

export function buildGraphContext(args: {
  primarySymbol: string | null;
  scope: { files: string[]; symbolCount: number; edgeCount: number };
  queries: Array<{ name: string; result: unknown }>;
}): string {
  const lines: string[] = [];
  lines.push("## Graph context");
  lines.push("");
  const sym = args.primarySymbol ? `\`${args.primarySymbol}\`` : '`(none)`';
  lines.push(`**Primary symbol:** ${sym}`);
  lines.push(
    `**Scope:** ${args.scope.files.length} files, ${args.scope.symbolCount} symbols, ${args.scope.edgeCount} edges`,
  );

  const order = ["definitionOf", "callersOf", "calleesOf", "symbolsInFile", "recentlyChangedNear"];
  const byName = new Map<string, QueryEntry>();
  for (const q of args.queries) byName.set(q.name, q);

  for (const key of order) {
    const title = SECTION_TITLES[key] ?? key;
    const entry = byName.get(key);
    lines.push("");
    if (!entry) {
      lines.push(renderSection(title, null, true));
      continue;
    }
    const empty = isEmpty(key, entry.result);
    lines.push(renderSection(title, entry.result, empty));
  }

  return lines.join("\n");
}

const MAX_RENDERED_CANDIDATES = 5;
const MAX_UNRESOLVED_TARGETS_RENDERED = 5;

export function buildCausalChainSection(
  candidates: CausalCandidate[],
): string {
  const lines: string[] = [];
  lines.push("## Top causal candidates");
  lines.push("");

  if (candidates.length === 0) {
    lines.push(
      "_(none — scope was too small or had no recency signal)_",
    );
    return lines.join("\n");
  }

  lines.push(
    "Ranked by recency × topology × ambiguity × co-change. Higher score = more likely root-cause site.",
  );
  lines.push("");

  const limited = candidates.slice(0, MAX_RENDERED_CANDIDATES);
  for (let i = 0; i < limited.length; i++) {
    const c = limited[i];
    if (!c) continue;
    const fileLine = formatFileLine(c.file, c.line);
    const score = formatScore(c.score);
    lines.push(
      `${i + 1}. **\`${c.name}\`** (${fileLine}) — score ${score}, role=${c.role}, distance=${c.distance}`,
    );
    lines.push(`   ${c.rationale}`);
    const recent = pickRecent(c.recentChanges);
    if (recent) {
      const sha7 = recent.commit.slice(0, 7);
      lines.push(
        `   Recent: ${sha7} "${recent.subject}" (${recent.daysAgo}d ago)`,
      );
    }
    if (c.unresolvedCallTargets.length > 0) {
      const shown = c.unresolvedCallTargets
        .slice(0, MAX_UNRESOLVED_TARGETS_RENDERED)
        .join(", ");
      lines.push(`   Unresolved calls: ${shown}`);
    }
    if (i < limited.length - 1) lines.push("");
  }

  return lines.join("\n");
}

function formatFileLine(file: string | null, line: number | null): string {
  if (file === null) return "`(unknown location)`";
  if (line === null) return `\`${file}\``;
  return `\`${file}:${line}\``;
}

function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "0.0";
  return score.toFixed(1);
}

function pickRecent(
  recentChanges: CausalCandidate["recentChanges"],
): CausalCandidate["recentChanges"][number] | null {
  if (!recentChanges || recentChanges.length === 0) return null;
  const first = recentChanges[0];
  return first ?? null;
}
