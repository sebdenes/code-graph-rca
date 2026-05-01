import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveScope } from "../graph/scope.js";
import { indexScope } from "../graph/orchestrator.js";
import {
  definitionOf,
  symbolsInFile,
  callersOf,
  calleesOf,
  recentlyChangedNear,
} from "../graph/queries.js";
import type {
  CallerTree,
  CalleeTree,
  CausalCandidate,
  Definition,
} from "../types.js";
import { buildCausalChainSection, buildGraphContext } from "./context.js";
import { buildPrompt } from "./prompt.js";
import {
  createRecencyHydrator,
  hydrateCallerTree,
  hydrateCalleeTree,
} from "./recency.js";
import { buildCausalChain } from "./causal.js";

export type FailureScope =
  | { kind: "stack-trace"; text: string }
  | { kind: "failing-test"; path: string; testName?: string }
  | { kind: "symbol"; name: string; file?: string }
  | { kind: "file"; path: string };

export interface RcaRequest {
  failureScope: FailureScope;
  repoRoot: string;
  budget?: { maxFiles?: number; maxLoc?: number; maxDepth?: number };
  /** Persist the indexed graph to this SQLite file path. Default: in-memory. */
  persist?: string;
}

export interface RcaResult {
  graphContext: string;
  scope: { files: string[]; symbolCount: number; edgeCount: number };
  queries: Array<{ name: string; result: unknown }>;
  primarySymbol: string | null;
  prompt: string;
  notes: string[];
  causalCandidates: CausalCandidate[];
  firstHypothesis: string | null;
}

export async function runRca(req: RcaRequest): Promise<RcaResult> {
  const notes: string[] = [];
  const scopeResult = resolveScope(req.failureScope, req.repoRoot, req.budget ?? {});
  notes.push(...scopeResult.notes);

  const queries: Array<{ name: string; result: unknown }> = [];
  let primarySymbol: string | null = scopeResult.primarySymbol;

  if (scopeResult.files.length === 0) {
    notes.push("no seed files resolved; skipping graph index and queries");
    const scope = { files: [] as string[], symbolCount: 0, edgeCount: 0 };
    const graphContext = buildGraphContext({ primarySymbol, scope, queries });
    const causalCandidates: CausalCandidate[] = [];
    const causalSection = buildCausalChainSection(causalCandidates);
    const firstHypothesis: string | null = null;
    const prompt = buildPrompt({
      failure: req.failureScope,
      graphContext,
      causalSection,
      firstHypothesis,
    });
    return {
      graphContext,
      scope,
      queries,
      primarySymbol,
      prompt,
      notes,
      causalCandidates,
      firstHypothesis,
    };
  }

  const indexed = await indexScope({
    repoRoot: req.repoRoot,
    scope: scopeResult.files,
    maxFiles: req.budget?.maxFiles ?? 200,
    ...(req.persist ? { persist: req.persist } : {}),
  });

  try {
    const seeds = scopeResult.seeds;
    const firstSeed = seeds[0];

    // Decide anchor symbol.
    let anchor: string | null = primarySymbol;
    if (!anchor && firstSeed) {
      const seedSymbols = symbolsInFile(indexed.db, firstSeed);
      const pick = seedSymbols.find(
        (s) => s.kind === "function" || s.kind === "class" || s.kind === "const",
      );
      if (pick) {
        anchor = pick.name;
        primarySymbol = anchor;
      } else {
        notes.push(`no function/class/const symbol found in seed file ${firstSeed}`);
      }
    }
    // Failing-test or other scopes whose seed file has no eligible symbol:
    // search the rest of the in-scope files, preferring non-test files.
    if (!anchor) {
      const candidates = scopeResult.files.filter((f) => f !== firstSeed);
      const ordered = [
        ...candidates.filter((f) => !/\.test\.|\.spec\./.test(f)),
        ...candidates.filter((f) => /\.test\.|\.spec\./.test(f)),
      ];
      for (const file of ordered) {
        const syms = symbolsInFile(indexed.db, file);
        const pick = syms.find(
          (s) => s.kind === "function" || s.kind === "class" || s.kind === "const",
        );
        if (pick) {
          anchor = pick.name;
          primarySymbol = anchor;
          notes.push(`anchor fallback: picked ${anchor} from ${file}`);
          break;
        }
      }
    }

    let callerTree: CallerTree | null = null;
    let calleeTree: CalleeTree | null = null;
    let anchorDefs: Definition[] = [];

    if (anchor) {
      anchorDefs = definitionOf(indexed.db, anchor);
      queries.push({ name: "definitionOf", result: anchorDefs });

      callerTree = callersOf(indexed.db, anchor, { depth: 2, minConfidence: 0.5 });
      queries.push({ name: "callersOf", result: callerTree });

      calleeTree = calleesOf(indexed.db, anchor, { depth: 1 });
      queries.push({ name: "calleesOf", result: calleeTree });

      if (firstSeed) {
        const seedSymbols = symbolsInFile(indexed.db, firstSeed);
        queries.push({ name: "symbolsInFile", result: seedSymbols });
      }

      const recent = recentlyChangedNear(indexed.db, anchor, {
        repoRoot: req.repoRoot,
        sinceDays: 90,
      });
      queries.push({ name: "recentlyChangedNear", result: recent });
    } else {
      notes.push("no anchor symbol; queries skipped");
    }

    // Hydrate recency on the trees if we have a real git repo.
    if (callerTree && calleeTree && isGitRepo(req.repoRoot)) {
      const hydrator = createRecencyHydrator({ repoRoot: req.repoRoot });
      hydrateCallerTree(callerTree, indexed.db, hydrator);
      hydrateCalleeTree(calleeTree, indexed.db, hydrator);
    }

    // Build the ranked causal-candidate shortlist.
    let causalCandidates: CausalCandidate[] = [];
    if (anchor && callerTree && calleeTree) {
      const firstDef = anchorDefs[0] ?? null;
      const anchorInput = {
        name: anchor,
        file: firstDef?.file ?? null,
        line: firstDef?.startLine ?? null,
      };
      try {
        causalCandidates = buildCausalChain(
          {
            anchor: anchorInput,
            callerTree,
            calleeTree,
            db: indexed.db,
          },
          { recencyDays: 90, topN: 5 },
        );
      } catch (err) {
        notes.push(
          `causal chain scorer failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const firstHypothesis = computeFirstHypothesis(causalCandidates);

    const scope = {
      files: scopeResult.files,
      symbolCount: indexed.symbolCount,
      edgeCount: indexed.edgeCount,
    };
    const graphContext = buildGraphContext({ primarySymbol, scope, queries });
    const causalSection = buildCausalChainSection(causalCandidates);
    const prompt = buildPrompt({
      failure: req.failureScope,
      graphContext,
      causalSection,
      firstHypothesis,
    });

    return {
      graphContext,
      scope,
      queries,
      primarySymbol,
      prompt,
      notes,
      causalCandidates,
      firstHypothesis,
    };
  } finally {
    indexed.db.close();
  }
}

function isGitRepo(repoRoot: string): boolean {
  try {
    return existsSync(join(repoRoot, ".git"));
  } catch {
    return false;
  }
}

function computeFirstHypothesis(
  candidates: CausalCandidate[],
): string | null {
  if (candidates.length === 0) return null;
  const top = candidates[0];
  if (!top) return null;
  const loc =
    top.file !== null
      ? top.line !== null
        ? `${top.file}:${top.line}`
        : top.file
      : "unknown location";
  return `The root cause is most likely in ${top.name} (${loc}) — ${top.rationale}`;
}
