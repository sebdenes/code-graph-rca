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
import { tryConnectBridge, type BridgeClient } from "./bridge.js";

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
}

let _cached: { repoRoot: string; handle: IndexedHandle } | null = null;

async function ensureIndex(repoRoot: string): Promise<IndexedHandle> {
  if (_cached && _cached.repoRoot === repoRoot) return _cached.handle;
  if (_cached) {
    try {
      _cached.handle.db.close();
    } catch {
      // best-effort
    }
  }
  const result = await indexScope({ repoRoot });
  const handle: IndexedHandle = {
    db: result.db,
    symbolCount: result.symbolCount,
    edgeCount: result.edgeCount,
  };
  _cached = { repoRoot, handle };
  return handle;
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
      const result = await runRca({ failureScope: failure, repoRoot: opts.repoRoot });
      return { content: [{ type: "text" as const, text: result.prompt }] };
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

function buildFailureScope(args: {
  failureKind: "stack-trace" | "failing-test" | "symbol" | "file";
  text?: string | undefined;
  path?: string | undefined;
  testName?: string | undefined;
  name?: string | undefined;
  file?: string | undefined;
}): import("../rca/runner.js").FailureScope {
  switch (args.failureKind) {
    case "stack-trace":
      return { kind: "stack-trace", text: args.text ?? "" };
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
