/**
 * cgrca MCP server.
 *
 * Exposes the indexed-scope code knowledge graph as MCP tools so any
 * MCP-aware agent (Cursor, Claude Code, Cody, Cline, Continue, Windsurf,
 * Zed AI, …) can ground its reasoning in real structural facts about the
 * user's codebase.
 *
 * Architecture: a single MCP server instance owns one repo root. The
 * graph is built lazily on the first query (the typical "scope-then-index"
 * cgrca pattern) and kept warm for subsequent queries in the same session.
 * The wrapper holds a single `indexed` handle plus per-tool wrappers that
 * deserialize/serialize via the existing query API.
 *
 * Transport: stdio (the canonical MCP transport — every client supports it).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Database } from "better-sqlite3";
import { indexScope } from "../graph/orchestrator.js";
import {
  callersOf,
  calleesOf,
  definitionOf,
  recentlyChangedNear,
  symbolsInFile,
} from "../graph/queries.js";
import { runRca } from "../rca/runner.js";
import { resolveScope } from "../graph/scope.js";
import { walk } from "../graph/walker.js";
import { buildLlmPrompt } from "../rca/llm/index.js";
import { tryConnectBridge, type BridgeClient } from "./bridge.js";
import { isDaemonUp, callDaemon } from "../daemon/client.js";

/**
 * If the daemon is up AND has this repo already indexed, call it via JSON-RPC.
 * Returns null otherwise — the caller falls through to the in-process path.
 * Never spawns the daemon and never asks it to index. The user controls daemon
 * lifecycle via `cgrca daemon start`.
 */
async function tryDaemon<R = unknown>(
  method: string,
  repoRoot: string,
  params: Record<string, unknown>,
): Promise<R | null> {
  try {
    if (!(await isDaemonUp())) return null;
    const status = await callDaemon<{ repos?: string[] }>(
      "status",
      {},
      { timeoutMs: 800 },
    );
    if (!status.repos?.includes(repoRoot)) return null;
    return await callDaemon<R>(method, { repoRoot, ...params }, { timeoutMs: 5000 });
  } catch {
    return null;
  }
}

function logVia(tool: string, via: "daemon" | "in-process"): void {
  process.stderr.write(`cgrca mcp: tool=${tool} via=${via}\n`);
}

interface ServerOptions {
  /** Repo root the agent will be querying against. */
  repoRoot: string;
  /** Optional: pre-build the index on startup instead of lazily. */
  warmIndex?: boolean;
}

interface IndexedHandle {
  db: Database;
  symbolCount: number;
  edgeCount: number;
  mtime: number;
}

/**
 * Per-repoRoot in-flight cache.
 *
 * The previous singleton (`_cached`) had two races:
 *   1. Two concurrent tool calls for the same repo would each invoke
 *      `indexScope`, double the work, and the second `db.close()` would
 *      yank the handle out from under the first request mid-flight ("Db
 *      is closed" / silent corruption).
 *   2. A second repo's request would synchronously close the first repo's
 *      DB even if its callers were still mid-query.
 *
 * Fix: cache `Promise<IndexedHandle>` keyed by repoRoot. Concurrent
 * callers for the same repo await the same promise (indexScope runs
 * once). Different repos get independent entries; old entries for *other*
 * repos are evicted lazily and only closed *after* their promise settles,
 * so in-flight queries on the old handle keep working.
 */
const _indexCache = new Map<string, Promise<IndexedHandle>>();

/** Stale entries past this age are re-indexed on next request. */
const TTL_MS = 5 * 60 * 1000;

/** @internal — test-only. Drops the cache and best-effort closes settled DBs. */
export async function _resetCache(): Promise<void> {
  const entries = Array.from(_indexCache.values());
  _indexCache.clear();
  for (const p of entries) {
    try {
      const h = await p;
      try {
        h.db.close();
      } catch {
        // best-effort
      }
    } catch {
      // settled-with-error: nothing to close
    }
  }
}

/** @internal — exported for tests. Public callers should not import this. */
export async function _ensureIndex(repoRoot: string): Promise<IndexedHandle> {
  return ensureIndex(repoRoot);
}

async function ensureIndex(repoRoot: string): Promise<IndexedHandle> {
  const existing = _indexCache.get(repoRoot);
  if (existing) {
    try {
      const h = await existing;
      if (Date.now() - h.mtime < TTL_MS) return h;
      // Stale — evict and fall through to re-index. Close the old DB
      // *after* we've removed it from the map so no new caller adopts it.
      _indexCache.delete(repoRoot);
      try {
        h.db.close();
      } catch {
        // best-effort
      }
    } catch {
      // Previous attempt failed; drop it and retry.
      _indexCache.delete(repoRoot);
    }
  }

  // Evict entries for *other* repoRoots, but defer their close() until
  // after their promise settles so any in-flight query completes safely.
  for (const [key, pending] of _indexCache) {
    if (key === repoRoot) continue;
    _indexCache.delete(key);
    void pending.then(
      (h) => {
        try {
          h.db.close();
        } catch {
          // best-effort
        }
      },
      () => {
        /* errored — nothing to close */
      },
    );
  }

  const promise = (async (): Promise<IndexedHandle> => {
    const result = await indexScope({ repoRoot });
    return {
      db: result.db,
      symbolCount: result.symbolCount,
      edgeCount: result.edgeCount,
      mtime: Date.now(),
    };
  })();
  _indexCache.set(repoRoot, promise);
  // If indexing fails, drop the failed promise so the next call retries.
  promise.catch(() => {
    if (_indexCache.get(repoRoot) === promise) _indexCache.delete(repoRoot);
  });
  return promise;
}

function asJson(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export async function startMcpServer(opts: ServerOptions): Promise<void> {
  const server = new McpServer({
    name: "cgrca",
    version: "0.3.0",
  });

  // Bridge mode is opt-in: if no `~/.cgrca/bridge.json` exists, `bridge` is
  // null and the new tools degrade gracefully to `{ none: true }`. Existing
  // tools work exactly as before.
  const bridge: BridgeClient | null = tryConnectBridge();

  /** Publish a focus event when the agent targets a symbol — best-effort. */
  const publishFocus = async (
    name: string,
    file: string | null,
    line: number | null,
  ): Promise<void> => {
    if (!bridge) return;
    if (!file || typeof line !== "number") return;
    await bridge.postSelection({ name, file, line });
  };

  // ---- Tool: definitionOf ----
  server.registerTool(
    "cgrca_definitionOf",
    {
      description:
        "Find every declaration of a symbol by name. Returns file, line range, signature, exported flag, language, subsystem. Optionally filter by language ('typescript' | 'python') or subsystem.",
      inputSchema: {
        name: z.string().describe("Symbol name to look up"),
        language: z.enum(["typescript", "python"]).optional(),
        subsystem: z.string().optional(),
      },
    },
    async ({ name, language, subsystem }) => {
      const params: Record<string, unknown> = { name };
      if (language) params.language = language;
      if (subsystem) params.subsystem = subsystem;
      const viaDaemon = await tryDaemon<ReturnType<typeof definitionOf>>(
        "define", opts.repoRoot, params,
      );
      if (viaDaemon !== null) {
        logVia("cgrca_definitionOf", "daemon");
        const first = viaDaemon[0];
        if (first) await publishFocus(first.name, first.file, first.startLine);
        return asJson(viaDaemon);
      }
      logVia("cgrca_definitionOf", "in-process");
      const { db } = await ensureIndex(opts.repoRoot);
      const queryOpts: { language?: "typescript" | "python"; subsystem?: string } = {};
      if (language) queryOpts.language = language;
      if (subsystem) queryOpts.subsystem = subsystem;
      const defs = definitionOf(db, name, queryOpts);
      const first = defs[0];
      if (first) await publishFocus(first.name, first.file, first.startLine);
      return asJson(defs);
    },
  );

  // ---- Tool: callersOf ----
  server.registerTool(
    "cgrca_callersOf",
    {
      description:
        "Reverse call tree from a symbol. Returns nodes (callers) up to depth, deduped by (file, name), with confidence. Default depth 2, min confidence 0.5.",
      inputSchema: {
        name: z.string().describe("Symbol whose callers to walk"),
        depth: z.number().int().min(1).max(5).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
      },
    },
    async ({ name, depth, minConfidence }) => {
      const params: Record<string, unknown> = { name };
      if (typeof depth === "number") params.depth = depth;
      if (typeof minConfidence === "number") params.minConfidence = minConfidence;
      const viaDaemon = await tryDaemon<ReturnType<typeof callersOf>>(
        "callers", opts.repoRoot, params,
      );
      if (viaDaemon !== null) {
        logVia("cgrca_callersOf", "daemon");
        return asJson(viaDaemon);
      }
      logVia("cgrca_callersOf", "in-process");
      const { db } = await ensureIndex(opts.repoRoot);
      const queryOpts: { depth?: number; minConfidence?: number } = {};
      if (typeof depth === "number") queryOpts.depth = depth;
      if (typeof minConfidence === "number") queryOpts.minConfidence = minConfidence;
      // Implicit focus: the seed of a callers walk IS the agent's focus.
      const defs = definitionOf(db, name);
      const first = defs[0];
      if (first) await publishFocus(first.name, first.file, first.startLine);
      return asJson(callersOf(db, name, queryOpts));
    },
  );

  // ---- Tool: calleesOf ----
  server.registerTool(
    "cgrca_calleesOf",
    {
      description:
        "Forward call tree from a symbol. Unresolved targets surface with resolved=false and the to_name preserved (grep-bait for the agent). Default depth 1.",
      inputSchema: {
        name: z.string(),
        depth: z.number().int().min(1).max(4).optional(),
      },
    },
    async ({ name, depth }) => {
      const params: Record<string, unknown> = { name };
      if (typeof depth === "number") params.depth = depth;
      const viaDaemon = await tryDaemon<ReturnType<typeof calleesOf>>(
        "callees", opts.repoRoot, params,
      );
      if (viaDaemon !== null) {
        logVia("cgrca_calleesOf", "daemon");
        return asJson(viaDaemon);
      }
      logVia("cgrca_calleesOf", "in-process");
      const { db } = await ensureIndex(opts.repoRoot);
      const queryOpts: { depth?: number } = {};
      if (typeof depth === "number") queryOpts.depth = depth;
      const defs = definitionOf(db, name);
      const first = defs[0];
      if (first) await publishFocus(first.name, first.file, first.startLine);
      return asJson(calleesOf(db, name, queryOpts));
    },
  );

  // ---- Tool: symbolsInFile ----
  server.registerTool(
    "cgrca_symbolsInFile",
    {
      description: "Every symbol declared in a file, in source order.",
      inputSchema: {
        path: z.string().describe("Repo-relative POSIX path"),
      },
    },
    async ({ path }) => {
      const { db } = await ensureIndex(opts.repoRoot);
      return asJson(symbolsInFile(db, path));
    },
  );

  // ---- Tool: recentlyChangedNear ----
  server.registerTool(
    "cgrca_recentlyChangedNear",
    {
      description:
        "Recent commits touching the lines of a symbol. Uses git log -L. Default sinceDays=90, maxCommits=20.",
      inputSchema: {
        name: z.string(),
        sinceDays: z.number().int().min(1).max(3650).optional(),
        maxCommits: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ name, sinceDays, maxCommits }) => {
      const params: Record<string, unknown> = { name };
      if (typeof sinceDays === "number") params.sinceDays = sinceDays;
      if (typeof maxCommits === "number") params.maxCommits = maxCommits;
      const viaDaemon = await tryDaemon<ReturnType<typeof recentlyChangedNear>>(
        "changed", opts.repoRoot, params,
      );
      if (viaDaemon !== null) {
        logVia("cgrca_recentlyChangedNear", "daemon");
        return asJson(viaDaemon);
      }
      logVia("cgrca_recentlyChangedNear", "in-process");
      const { db } = await ensureIndex(opts.repoRoot);
      const queryOpts: { repoRoot: string; sinceDays?: number; maxCommits?: number } = {
        repoRoot: opts.repoRoot,
      };
      if (typeof sinceDays === "number") queryOpts.sinceDays = sinceDays;
      if (typeof maxCommits === "number") queryOpts.maxCommits = maxCommits;
      return asJson(recentlyChangedNear(db, name, queryOpts));
    },
  );

  // ---- Tool: rca (the killer tool) ----
  server.registerTool(
    "cgrca_rca",
    {
      description:
        "Full RCA against a failure scope: stack-trace text, failing-test path, symbol name, or file path. Returns ranked causal candidates (recency × proximity × ambiguity × co-change × subsystem), a first-hypothesis sentence, and the structured prompt the agent should reason against.",
      inputSchema: {
        failureKind: z.enum(["stack-trace", "failing-test", "symbol", "file"]),
        text: z
          .string()
          .optional()
          .describe("Stack trace text (when failureKind=stack-trace)"),
        path: z
          .string()
          .optional()
          .describe("Test or source path (when failureKind=failing-test|file)"),
        testName: z.string().optional(),
        name: z.string().optional().describe("Symbol name (when failureKind=symbol)"),
        file: z.string().optional().describe("Optional file disambiguator for symbol mode"),
        maxFiles: z.number().int().min(1).max(2000).optional(),
        maxLoc: z.number().int().min(100).max(200000).optional(),
        maxDepth: z.number().int().min(1).max(5).optional(),
      },
    },
    async (args) => {
      const failure = buildFailureScope(args);
      const budget: { maxFiles?: number; maxLoc?: number; maxDepth?: number } = {};
      if (typeof args.maxFiles === "number") budget.maxFiles = args.maxFiles;
      if (typeof args.maxLoc === "number") budget.maxLoc = args.maxLoc;
      if (typeof args.maxDepth === "number") budget.maxDepth = args.maxDepth;
      const rpcParams: Record<string, unknown> = { failure };
      if (Object.keys(budget).length > 0) rpcParams.budget = budget;
      const viaDaemon = await tryDaemon<Awaited<ReturnType<typeof runRca>>>(
        "rca", opts.repoRoot, rpcParams,
      );
      if (viaDaemon !== null) {
        logVia("cgrca_rca", "daemon");
        const { prompt: _prompt, ...rest } = viaDaemon;
        void _prompt;
        return asJson(rest);
      }
      logVia("cgrca_rca", "in-process");
      const result = await runRca({
        failureScope: failure,
        repoRoot: opts.repoRoot,
        budget,
      });
      // Strip the prompt from the JSON payload — agents that want the prompt
      // call cgrca_rcaPrompt instead. Keeping both compact and full surfaces.
      const { prompt: _prompt, ...rest } = result;
      void _prompt;
      return asJson(rest);
    },
  );

  // ---- Tool: rcaPrompt (full prompt for direct LLM ingestion) ----
  server.registerTool(
    "cgrca_rcaPrompt",
    {
      description:
        "Same as cgrca_rca but returns ONLY the assembled prompt as a single text block — failure context, top causal candidates, first hypothesis, graph context, RCA protocol. Drop straight into your reasoning loop.",
      inputSchema: {
        failureKind: z.enum(["stack-trace", "failing-test", "symbol", "file"]),
        text: z.string().optional(),
        path: z.string().optional(),
        testName: z.string().optional(),
        name: z.string().optional(),
        file: z.string().optional(),
      },
    },
    async (args) => {
      const failure = buildFailureScope(args);
      const viaDaemon = await tryDaemon<Awaited<ReturnType<typeof runRca>>>(
        "rca", opts.repoRoot, { failure },
      );
      if (viaDaemon !== null) {
        logVia("cgrca_rcaPrompt", "daemon");
        return { content: [{ type: "text" as const, text: viaDaemon.prompt }] };
      }
      logVia("cgrca_rcaPrompt", "in-process");
      const result = await runRca({ failureScope: failure, repoRoot: opts.repoRoot });
      return { content: [{ type: "text" as const, text: result.prompt }] };
    },
  );

  // ---- Tool: rcaWithReasoning (Phase 2 / Phase 3 — LLM-augmented RCA, no API key) ----
  server.registerTool(
    "cgrca_rcaWithReasoning",
    {
      description:
        "v0.5 Phase 2/3: free-text RCA with body previews + 1-hop neighbors per candidate, returned as a single structured prompt + JSON output schema. The HOST LLM (you, Claude) reasons over the candidate set inline and emits a verdict — no external API call, no API key needed. Pair with prose / partial-trace failure descriptions where cgrca_rca returns 0 candidates today. Output is the prompt; you respond with the verdict JSON the schema describes.",
      inputSchema: {
        failure: z
          .string()
          .describe(
            "Failure description as prose, intent statement, or partial trace. Free-form text — cgrca tokenizes + matches against the indexed graph.",
          ),
        topK: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Candidates to include in the prompt (default 10)"),
        maxBodyLines: z
          .number()
          .int()
          .min(5)
          .max(100)
          .optional()
          .describe("Max source lines per candidate body preview (default 30)"),
        maxFiles: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Cap on files indexed (default 200; bump for large repos)"),
      },
    },
    async ({ failure, topK, maxBodyLines, maxFiles }) => {
      const failureScope: import("../rca/runner.js").FailureScope = {
        kind: "free-text",
        text: failure,
      };
      const budget: { maxFiles?: number } = {};
      if (typeof maxFiles === "number") budget.maxFiles = maxFiles;

      const result = await runRca({
        failureScope,
        repoRoot: opts.repoRoot,
        budget,
        topN: topK ?? 10,
      });
      logVia("cgrca_rcaWithReasoning", "in-process");

      if (result.causalCandidates.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `cgrca_rcaWithReasoning: free-text RCA returned no candidates. ` +
                `Notes:\n${result.notes.map((n) => `  - ${n}`).join("\n")}`,
            },
          ],
        };
      }

      // Re-index broadly so we have a Db handle for body/caller/callee
      // hydration in buildLlmPrompt. Wasteful — same as the CLI --llm path.
      const broadFiles = walk(opts.repoRoot)
        .filter((f) => f.language === "typescript" || f.language === "python")
        .slice(0, budget.maxFiles ?? 200)
        .map((f) => f.relPath);

      const indexed = await indexScope({
        repoRoot: opts.repoRoot,
        scope: broadFiles,
        ...(budget.maxFiles !== undefined ? { maxFiles: budget.maxFiles } : {}),
      });
      try {
        const built = buildLlmPrompt({
          failureDescription: failure,
          candidates: result.causalCandidates,
          db: indexed.db,
          repoRoot: opts.repoRoot,
          ...(topK !== undefined ? { topK } : {}),
          ...(maxBodyLines !== undefined ? { maxBodyLines } : {}),
          // No maxInputTokens cap — host LLM has its own context window;
          // returning the full hydrated prompt is the right default.
        });
        // Compose system + user into a single text block for the host LLM.
        const text =
          `# Cgrca LLM-augmented RCA\n\n` +
          `${built.system}\n\n---\n\n${built.user}\n\n---\n\n` +
          `Now respond with the verdict JSON described in the schema above.`;
        return { content: [{ type: "text" as const, text }] };
      } finally {
        indexed.db.close();
      }
    },
  );

  // ---- Tool: enrichCandidates (v0.6 Phase 6 — structural layer for any retriever) ----
  server.registerTool(
    "cgrca_enrichCandidates",
    {
      description:
        "v0.6 structural layer for code-RCA. Accepts a list of (file, symbol) candidates from ANY retriever (Cursor @codebase, Copilot, Continue, embedding-RAG, hand-typed) and returns each annotated with cgrca's structural facts: definition info, body preview, 1-hop callers/callees, and recent commits touching the symbol's lines. The host LLM picks the most likely root cause from the enriched set — cgrca's value is in providing facts no embedding-similarity score can give.",
      inputSchema: {
        candidates: z
          .array(
            z.object({
              file: z.string().describe("Path relative to repo root"),
              symbol: z.string().optional().describe("Symbol name; if omitted, all symbols in file"),
              line: z.number().int().min(1).optional().describe("Optional line hint for symbol disambiguation"),
            }),
          )
          .min(1)
          .describe("Candidates from any retriever to enrich"),
        includeBody: z.boolean().optional().describe("Include body preview (default true; up to 30 lines per symbol)"),
        includeNeighbors: z.boolean().optional().describe("Include 1-hop callers/callees (default true; top 3 each)"),
        includeRecency: z.boolean().optional().describe("Include recent commits touching the symbol's lines (default true; last 5)"),
        maxBodyLines: z.number().int().min(5).max(100).optional().describe("Max lines per body preview (default 30)"),
        maxFiles: z.number().int().min(1).max(2000).optional().describe("Cap on files indexed (default 200)"),
      },
    },
    async ({ candidates, includeBody, includeNeighbors, includeRecency, maxBodyLines, maxFiles }) => {
      const wantBody = includeBody !== false;
      const wantNeighbors = includeNeighbors !== false;
      const wantRecency = includeRecency !== false;
      const bodyLines = maxBodyLines ?? 30;

      // Index broadly so we have a Db that knows about every candidate's
      // file. Same approach as cgrca_rcaWithReasoning — re-index here so
      // the tool is self-contained (no warm-up step needed).
      const broadFiles = walk(opts.repoRoot)
        .filter((f) => f.language === "typescript" || f.language === "python")
        .slice(0, maxFiles ?? 200)
        .map((f) => f.relPath);
      const indexed = await indexScope({
        repoRoot: opts.repoRoot,
        scope: broadFiles,
        ...(maxFiles !== undefined ? { maxFiles } : {}),
      });
      logVia("cgrca_enrichCandidates", "in-process");
      try {
        const enriched = await Promise.all(
          candidates.map(async (cand) => enrichOne(indexed.db, opts.repoRoot, cand, {
            wantBody,
            wantNeighbors,
            wantRecency,
            bodyLines,
          })),
        );
        return asJson({ enriched });
      } finally {
        indexed.db.close();
      }
    },
  );

  // ---- Tool: scope (preview which files cgrca would index for a failure, no parse) ----
  server.registerTool(
    "cgrca_scope",
    {
      description:
        "Preview the file set cgrca would index for a failure scope, without actually parsing. Cheap dry-run — useful when the agent wants to confirm coverage before a full RCA.",
      inputSchema: {
        failureKind: z.enum(["stack-trace", "failing-test", "symbol", "file"]),
        text: z.string().optional(),
        path: z.string().optional(),
        testName: z.string().optional(),
        name: z.string().optional(),
        file: z.string().optional(),
        maxFiles: z.number().int().min(1).max(2000).optional(),
        maxLoc: z.number().int().min(100).max(200000).optional(),
        maxDepth: z.number().int().min(1).max(5).optional(),
      },
    },
    async (args) => {
      const failure = buildFailureScope(args);
      const budget: { maxFiles?: number; maxLoc?: number; maxDepth?: number } = {};
      if (typeof args.maxFiles === "number") budget.maxFiles = args.maxFiles;
      if (typeof args.maxLoc === "number") budget.maxLoc = args.maxLoc;
      if (typeof args.maxDepth === "number") budget.maxDepth = args.maxDepth;
      const scope = resolveScope(failure, opts.repoRoot, budget);
      return asJson(scope);
    },
  );

  // ---- Tool: cgrca_currentSelection (bridge mode read) ----
  server.registerTool(
    "cgrca_currentSelection",
    {
      description:
        "Bridge mode: read the symbol the user is currently focused on in the cgrca-view UI on the same machine. Returns { none: true } when no UI is running or nothing is selected. Discovery is by-convention via ~/.cgrca/bridge.json.",
      inputSchema: {},
    },
    async () => {
      if (!bridge) return asJson({ none: true });
      const sel = await bridge.getSelection();
      if (!sel) return asJson({ none: true });
      return asJson(sel);
    },
  );

  // ---- Tool: cgrca_publishSelection (bridge mode write) ----
  server.registerTool(
    "cgrca_publishSelection",
    {
      description:
        "Bridge mode: tell the cgrca-view UI 'I'm now focused on this symbol' so it highlights in the open browser graph. No-op when no UI is connected.",
      inputSchema: {
        name: z.string(),
        file: z.string(),
        line: z.number().int().min(1),
      },
    },
    async ({ name, file, line }) => {
      if (!bridge) return asJson({ ok: false, reason: "no-bridge" });
      const ok = await bridge.postSelection({ name, file, line });
      return asJson({ ok });
    },
  );

  if (opts.warmIndex) {
    await ensureIndex(opts.repoRoot);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

interface EnrichInput {
  file: string;
  symbol?: string | undefined;
  line?: number | undefined;
}

interface EnrichOptions {
  wantBody: boolean;
  wantNeighbors: boolean;
  wantRecency: boolean;
  bodyLines: number;
}

interface EnrichedCandidate {
  /** Echo of input. */
  input: EnrichInput;
  /** Resolved symbol name (== input.symbol when provided + found). */
  symbol: string | null;
  /** Path relative to repo root. */
  file: string;
  /** Resolved start/end line range from definitionOf. */
  startLine: number | null;
  endLine: number | null;
  /** Symbol kind (function/method/class/...) — null when not found in graph. */
  kind: string | null;
  /** Body length in lines (end - start + 1) — null when not found. */
  loc: number | null;
  /** Subsystem (workspace package or top-level dir). */
  subsystem: string | null;
  /** Optional fields populated based on EnrichOptions. */
  body?: { text: string; startLine: number; endLine: number; truncated: boolean; language: string };
  callers?: Array<{ file: string; symbol: string; line: number }>;
  callees?: Array<{ file: string; symbol: string; line: number }>;
  recentChanges?: Array<{ commit: string; date: string; subject: string; author: string }>;
  /** Note explaining gaps (file not indexed, symbol not found, etc.). */
  notes: string[];
}

async function enrichOne(
  db: Database,
  repoRoot: string,
  cand: EnrichInput,
  opts: EnrichOptions,
): Promise<EnrichedCandidate> {
  const { fetchBody } = await import("../rca/llm/body.js");
  const out: EnrichedCandidate = {
    input: cand,
    symbol: cand.symbol ?? null,
    file: cand.file,
    startLine: null,
    endLine: null,
    kind: null,
    loc: null,
    subsystem: null,
    notes: [],
  };

  // Resolve symbol via definitionOf — may return multiple defs (overloads).
  // Pick the one matching candidate's file; if line hint provided, also
  // require the symbol's range to contain it.
  const symName = cand.symbol;
  if (!symName) {
    out.notes.push("no symbol provided; skipping definition lookup");
    return out;
  }
  const defs = definitionOf(db, symName);
  let pick = defs.find((d) => d.file === cand.file);
  if (pick && cand.line !== undefined) {
    const inRange = defs.find(
      (d) => d.file === cand.file && d.startLine <= cand.line! && d.endLine >= cand.line!,
    );
    if (inRange) pick = inRange;
  }
  if (!pick) {
    out.notes.push(`symbol "${symName}" not found in indexed graph for ${cand.file} (file may be past --max-files budget)`);
    return out;
  }
  out.symbol = pick.name;
  out.startLine = pick.startLine;
  out.endLine = pick.endLine;
  out.kind = pick.kind;
  out.loc = pick.endLine - pick.startLine + 1;
  out.subsystem = pick.subsystem ?? null;

  if (opts.wantBody) {
    const snip = fetchBody(repoRoot, pick.file, pick.startLine, pick.endLine, opts.bodyLines);
    if (snip) {
      out.body = {
        text: snip.body,
        startLine: snip.startLine,
        endLine: snip.endLine,
        truncated: snip.truncated,
        language: snip.language,
      };
    }
  }

  if (opts.wantNeighbors) {
    const callerTree = callersOf(db, symName, { depth: 1, minConfidence: 0.5 });
    const calleeTree = calleesOf(db, symName, { depth: 1 });
    out.callers = (callerTree?.callers ?? [])
      .slice(0, 3)
      .map((n) => ({ symbol: n.name, file: n.file, line: n.line }));
    // Callees may be unresolved (file/line null for stdlib / external pkg
     // calls). Filter to only resolved callees so the LLM doesn't get
     // pointed at "we don't know where this is."
    out.callees = (calleeTree?.callees ?? [])
      .filter((n): n is typeof n & { file: string; line: number } =>
        n.file !== null && n.line !== null,
      )
      .slice(0, 3)
      .map((n) => ({ symbol: n.name, file: n.file, line: n.line }));
  }

  if (opts.wantRecency) {
    try {
      const changes = recentlyChangedNear(db, symName, { repoRoot, sinceDays: 90 });
      out.recentChanges = (changes ?? []).slice(0, 5).map((c) => ({
        commit: c.commit,
        date: c.date,
        subject: c.subject,
        author: c.author,
      }));
    } catch (err) {
      out.notes.push(`recency lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return out;
}

function buildFailureScope(args: {
  failureKind: "stack-trace" | "failing-test" | "symbol" | "file" | "free-text";
  text?: string | undefined;
  path?: string | undefined;
  testName?: string | undefined;
  name?: string | undefined;
  file?: string | undefined;
}): import("../rca/runner.js").FailureScope {
  switch (args.failureKind) {
    case "stack-trace":
      return { kind: "stack-trace", text: args.text ?? "" };
    case "free-text":
      return { kind: "free-text", text: args.text ?? "" };
    case "failing-test": {
      const v: import("../rca/runner.js").FailureScope = {
        kind: "failing-test",
        path: args.path ?? "",
      };
      if (args.testName) (v as { testName?: string }).testName = args.testName;
      return v;
    }
    case "symbol": {
      const v: import("../rca/runner.js").FailureScope = {
        kind: "symbol",
        name: args.name ?? "",
      };
      if (args.file) (v as { file?: string }).file = args.file;
      return v;
    }
    case "file":
      return { kind: "file", path: args.path ?? "" };
  }
}
