#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { runRca, type FailureScope } from "./rca/runner.js";
import { indexScope } from "./graph/orchestrator.js";
import {
  definitionOf,
  callersOf,
  calleesOf,
  recentlyChangedNear,
} from "./graph/queries.js";

const VERSION = "0.0.1";

const USAGE = `cgrca <command> [args] [options]

Commands:
  rca <failure>             Run RCA on a failure. Print prompt+graph context.
  index <path>              Index a scope and print summary stats.
  define <name>             definitionOf — find symbol declarations.
  callers <name>            callersOf with depth.
  callees <name>            calleesOf with depth.
  changed <name>            recentlyChangedNear — git log for symbol's lines.
  mcp [path]                Start MCP server on stdio (default repo: cwd).
                            Wire into Cursor / Claude Code / Cody / Cline /
                            Continue / Windsurf / Zed via their MCP config.
  init [path]               One-shot setup: detect editor MCP configs,
                            register cgrca, drop AGENTS.md at the repo root.
  version                   Print version.

<failure> formats:
  symbol:<name>             Investigate a symbol by name.
  file:<path>               Investigate a file.
  test:<path>               A failing test path.
  <path>                    A file containing a stack trace.

Common options:
  --repo <path>             Repo root (default: cwd).
  --json                    Emit JSON instead of human output (rca only).
  -d, --depth <n>           Depth for callers/callees (default 2 / 1).
  --since <days>            Days for changed (default 90).
  --max-files <n>           Scope budget for rca (default 200).
  --max-loc <n>             LOC budget for rca (default 20000).
  --persist <path>          Write the indexed graph to a SQLite file
                            (open with any sqlite browser to inspect).
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") {
      flags.json = true;
    } else if (a === "-d" || a === "--depth") {
      flags.depth = argv[++i] ?? "";
    } else if (a === "--since") {
      flags.since = argv[++i] ?? "";
    } else if (a === "--repo") {
      flags.repo = argv[++i] ?? "";
    } else if (a === "--max-files") {
      flags.maxFiles = argv[++i] ?? "";
    } else if (a === "--max-loc") {
      flags.maxLoc = argv[++i] ?? "";
    } else if (a === "--max-depth") {
      flags.maxDepth = argv[++i] ?? "";
    } else if (a === "--persist") {
      flags.persist = argv[++i] ?? "";
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function repoRootFrom(flags: Record<string, string | boolean>): string {
  return resolve(typeof flags.repo === "string" ? flags.repo : process.cwd());
}

function parseFailure(spec: string, repoRoot: string): FailureScope {
  if (spec.startsWith("symbol:")) return { kind: "symbol", name: spec.slice("symbol:".length) };
  if (spec.startsWith("file:")) return { kind: "file", path: spec.slice("file:".length) };
  if (spec.startsWith("test:")) return { kind: "failing-test", path: spec.slice("test:".length) };
  // Otherwise treat as a stack-trace file path.
  const abs = resolve(repoRoot, spec);
  if (existsSync(abs)) {
    const text = readFileSync(abs, "utf8");
    return { kind: "stack-trace", text };
  }
  // Fall back to symbol name.
  return { kind: "symbol", name: spec };
}

async function cmdRca(args: ParsedArgs): Promise<number> {
  const failureArg = args.positional[0];
  if (!failureArg) {
    process.stderr.write("rca: missing <failure> argument\n");
    return 2;
  }
  const repoRoot = repoRootFrom(args.flags);
  const failure = parseFailure(failureArg, repoRoot);
  const budget: { maxFiles?: number; maxLoc?: number; maxDepth?: number } = {};
  if (typeof args.flags.maxFiles === "string") budget.maxFiles = Number(args.flags.maxFiles);
  if (typeof args.flags.maxLoc === "string") budget.maxLoc = Number(args.flags.maxLoc);
  if (typeof args.flags.maxDepth === "string") budget.maxDepth = Number(args.flags.maxDepth);

  const persist = typeof args.flags.persist === "string" ? args.flags.persist : undefined;
  const result = await runRca({ failureScope: failure, repoRoot, budget, ...(persist ? { persist } : {}) });
  if (persist) {
    const persistAbs = resolve(persist);
    process.stderr.write(`graph persisted to ${persistAbs}\n`);
    // Sidecar JSON snapshot of the full RcaResult (lets the UI render any
    // sqlite without re-running the CLI).
    try {
      writeFileSync(`${persistAbs}.rca.json`, JSON.stringify(result, null, 2));
    } catch (err) {
      process.stderr.write(
        `warning: failed to write sidecar json: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    // Stamp the SQLite with repo_root + primary_symbol so it can be opened
    // standalone on another machine.
    try {
      const stampDb = new Database(persistAbs);
      stampDb.exec(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      const ins = stampDb.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      );
      ins.run("repo_root", repoRoot);
      ins.run("primary_symbol", result.primarySymbol ?? "");
      stampDb.close();
    } catch (err) {
      process.stderr.write(
        `warning: failed to stamp meta: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  if (args.flags.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(result.prompt);
    process.stdout.write("\n");
  }
  return 0;
}

async function cmdIndex(args: ParsedArgs): Promise<number> {
  const path = args.positional[0];
  if (!path) {
    process.stderr.write("index: missing <path> argument\n");
    return 2;
  }
  const repoRoot = resolve(path);
  const persist = typeof args.flags.persist === "string" ? args.flags.persist : undefined;
  const t0 = Date.now();
  const r = await indexScope({ repoRoot, ...(persist ? { persist } : {}) });
  const ms = Date.now() - t0;
  process.stdout.write(
    `indexed ${r.fileCount} files (${r.unparsedCount} unparsed), ${r.symbolCount} symbols, ${r.edgeCount} edges, ${r.importCount} imports in ${ms}ms\n`,
  );
  if (persist) process.stdout.write(`graph persisted to ${resolve(persist)}\n`);
  r.db.close();
  return 0;
}

async function cmdDefine(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    process.stderr.write("define: missing <name>\n");
    return 2;
  }
  const repoRoot = repoRootFrom(args.flags);
  const r = await indexScope({ repoRoot });
  const defs = definitionOf(r.db, name);
  if (defs.length === 0) {
    process.stdout.write(`no definitions for "${name}"\n`);
  } else {
    for (const d of defs) {
      process.stdout.write(
        `${d.kind} ${d.name}  ${d.file}:${d.startLine}-${d.endLine}  ${d.exported ? "exported" : "internal"}  [${d.language}]\n`,
      );
      if (d.signature) process.stdout.write(`  ${d.signature}\n`);
    }
  }
  r.db.close();
  return 0;
}

async function cmdCallers(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    process.stderr.write("callers: missing <name>\n");
    return 2;
  }
  const repoRoot = repoRootFrom(args.flags);
  const depth = typeof args.flags.depth === "string" ? Number(args.flags.depth) : 2;
  const r = await indexScope({ repoRoot });
  const tree = callersOf(r.db, name, { depth });
  process.stdout.write(JSON.stringify(tree, null, 2) + "\n");
  r.db.close();
  return 0;
}

async function cmdCallees(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    process.stderr.write("callees: missing <name>\n");
    return 2;
  }
  const repoRoot = repoRootFrom(args.flags);
  const depth = typeof args.flags.depth === "string" ? Number(args.flags.depth) : 1;
  const r = await indexScope({ repoRoot });
  const tree = calleesOf(r.db, name, { depth });
  process.stdout.write(JSON.stringify(tree, null, 2) + "\n");
  r.db.close();
  return 0;
}

async function cmdChanged(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    process.stderr.write("changed: missing <name>\n");
    return 2;
  }
  const repoRoot = repoRootFrom(args.flags);
  const sinceDays = typeof args.flags.since === "string" ? Number(args.flags.since) : 90;
  const r = await indexScope({ repoRoot });
  const changes = recentlyChangedNear(r.db, name, { repoRoot, sinceDays });
  if (changes.length === 0) {
    process.stdout.write(`no recent commits touching "${name}" in the last ${sinceDays}d\n`);
  } else {
    for (const c of changes) {
      process.stdout.write(`${c.commit.slice(0, 8)}  ${c.author}  ${c.date}  ${c.subject}  (${c.file})\n`);
    }
  }
  r.db.close();
  return 0;
}

async function cmdInit(args: ParsedArgs): Promise<number> {
  const repoRoot = resolve(args.positional[0] ?? process.cwd());
  // The MCP server is launched via this same CLI binary. We resolve to
  // the dist/cli.js absolute path so editor configs are stable across
  // working-directory changes.
  const { fileURLToPath } = await import("node:url");
  const cliPath = fileURLToPath(import.meta.url);
  const dryRun = args.flags["dry-run"] === true;
  const { runInit, formatInitResult } = await import("./init/install.js");
  const result = runInit({ cliPath, repoRoot, dryRun });
  process.stdout.write(formatInitResult(result, cliPath, repoRoot));
  return 0;
}

async function cmdMcp(args: ParsedArgs): Promise<number> {
  // [path] is optional; default cwd. We resolve it eagerly so the
  // server logs the actual repo root it'll be querying against.
  const repoRoot = resolve(args.positional[0] ?? process.cwd());
  // Stdio is the *expected* transport when a parent agent (Cursor, Claude
  // Code, ...) launches us. Anything we write to stdout would corrupt the
  // protocol stream, so log to stderr only.
  process.stderr.write(`cgrca mcp listening on stdio  (repo: ${repoRoot})\n`);
  // Late import keeps the cli startup fast for non-MCP invocations.
  const { startMcpServer } = await import("./mcp/server.js");
  await startMcpServer({ repoRoot });
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  const cmd = argv[0]!;
  const rest = argv.slice(1);
  const args = parseArgs(rest);

  switch (cmd) {
    case "rca":
      return cmdRca(args);
    case "index":
      return cmdIndex(args);
    case "define":
      return cmdDefine(args);
    case "callers":
      return cmdCallers(args);
    case "callees":
      return cmdCallees(args);
    case "mcp":
      return cmdMcp(args);
    case "init":
      return cmdInit(args);
    case "changed":
      return cmdChanged(args);
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(VERSION + "\n");
      return 0;
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

// Set exitCode and let the event loop drain stdout naturally — calling
// process.exit() synchronously truncates piped writes past the macOS pipe
// buffer (~8KB), which silently chops large --json prompts.
main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
