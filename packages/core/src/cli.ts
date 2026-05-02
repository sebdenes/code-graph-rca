#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { runRca, type FailureScope } from "./rca/runner.js";
import { indexScope } from "./graph/orchestrator.js";
import { openDb, type Db } from "./graph/db.js";
import {
  definitionOf,
  callersOf,
  calleesOf,
  recentlyChangedNear,
} from "./graph/queries.js";
import type { CausalCandidate } from "./types.js";

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
  daemon <start|stop|status>
                            Manage the cgrcad background process. Once
                            running, define/callers/callees/changed reuse
                            its sqlite handles instead of re-indexing.
  init [path]               One-shot setup: detect editor MCP configs,
                            register cgrca, drop AGENTS.md at the repo root.
                            Prints a plan; requires --yes (or interactive
                            y/N) to mutate user config. Use --dry-run to
                            preview without writing.
  version                   Print version.

<failure> formats:
  symbol:<name>             Investigate a symbol by name.
  file:<path>               Investigate a file.
  test:<path>               A failing test path.
  <path>                    A file containing a stack trace.

Common options:
  --repo <path>             Repo root (default: cwd).
  --format <shape>          rca: pick the output shape (table|prompt|json).
                            Default is table. Subsumes --json and --prompt.
  --json                    rca: alias for --format=json. (kept for compat)
  --prompt                  rca: alias for --format=prompt — emit the full
                            LLM-grounding markdown prompt. (kept for compat)
  -d, --depth <n>           Depth for callers/callees (default 2 / 1).
  --since <days>            Days for changed (default 90).
  --max-files <n>           Scope budget for rca (default 200).
  --max-loc <n>             LOC budget for rca (default 20000).
  --persist <path>          Write the indexed graph to a SQLite file (or reuse
                            it on warm queries; open with any sqlite browser
                            to inspect).
  --no-daemon               Force in-process indexing even when cgrcad is up.
  --top-n <n>               rca: number of causal candidates to return (default 5).
  --legacy-weights          rca: use the pre-calibration hand-set weights for
                            an A/B comparison against the calibrated default.
                            See packages/core/src/rca/causal.ts.
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
    } else if (a === "--no-daemon") {
      flags["no-daemon"] = true;
    } else if (a === "--top-n") {
      flags.topN = argv[++i] ?? "";
    } else if (a === "--legacy-weights") {
      flags["legacy-weights"] = true;
    } else if (a === "--format") {
      flags.format = argv[++i] ?? "";
    } else if (a.startsWith("--format=")) {
      flags.format = a.slice("--format=".length);
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

// Tiny ANSI helper. We avoid pulling in chalk just to color one column —
// emit raw escapes only when stdout is a TTY so piped/JSON consumers stay
// clean.
const USE_COLOR = process.stdout.isTTY === true;
function ansi(code: string, s: string): string {
  return USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const dim = (s: string) => ansi("2", s);
const bold = (s: string) => ansi("1", s);
const red = (s: string) => ansi("31", s);
const yellow = (s: string) => ansi("33", s);
const cyan = (s: string) => ansi("36", s);

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, n);
  return s.slice(0, n - 1) + "…";
}

function padRight(s: string, n: number): string {
  // Pads against visible length; we never put ANSI codes through here.
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

// Color the score column based on rank — top candidate red, fading to dim.
function colorScore(score: number, rank: number): string {
  const txt = score.toFixed(1);
  if (rank === 0) return bold(red(txt));
  if (rank === 1) return red(txt);
  if (rank === 2) return yellow(txt);
  return dim(txt);
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

interface RcaTableInput {
  primarySymbol: string | null;
  causalCandidates: CausalCandidate[];
  notes: string[];
}

function renderRcaTable(r: RcaTableInput): string {
  const lines: string[] = [];
  const total = r.causalCandidates.length;
  const anchor = r.causalCandidates.find((c) => c.role === "anchor");
  const anchorLoc =
    anchor && anchor.file && anchor.line != null
      ? `${basename(anchor.file)}:${anchor.line}`
      : anchor?.file ?? "-";
  const anchorName = anchor?.name ?? r.primarySymbol ?? "(no anchor)";

  if (total === 0) {
    lines.push(
      `${bold("CGRCA")} ${dim("·")} no causal candidates ${dim("·")} anchor: ${anchorName}`,
    );
    if (r.notes.length > 0) {
      lines.push("");
      for (const n of r.notes) lines.push(dim(`  note: ${n}`));
    }
    lines.push("");
    lines.push(
      dim(
        "Run with --prompt for the full LLM-grounding markdown. Run with --json for machine output.",
      ),
    );
    return lines.join("\n") + "\n";
  }

  lines.push(
    `${bold("CGRCA")} ${dim("·")} ${total} candidate${total === 1 ? "" : "s"} ${dim("·")} anchor: ${cyan(anchorName)} (${dim(anchorLoc)})`,
  );
  lines.push("");

  // Column widths: total ~120 cols.
  const W_RANK = 3;
  const W_SCORE = 6;
  const W_ROLE = 8;
  const W_SYMBOL = 28;
  const W_LOC = 36;
  // WHY gets the rest minus separators (5 gaps of 2 spaces = 10).
  const W_WHY = 120 - W_RANK - W_SCORE - W_ROLE - W_SYMBOL - W_LOC - 10;

  const header =
    padRight("#", W_RANK) +
    "  " +
    padRight("SCORE", W_SCORE) +
    "  " +
    padRight("ROLE", W_ROLE) +
    "  " +
    padRight("SYMBOL", W_SYMBOL) +
    "  " +
    padRight("LOC", W_LOC) +
    "  " +
    "WHY";
  lines.push(dim(header));

  for (let i = 0; i < r.causalCandidates.length; i++) {
    const c = r.causalCandidates[i]!;
    const loc =
      c.file && c.line != null
        ? `${basename(c.file)}:${c.line}`
        : c.file
          ? basename(c.file)
          : "-";
    const rankStr = padRight(String(i + 1), W_RANK);
    // Score: pad the visible text first, then wrap with ANSI.
    const scorePadded = padRight(c.score.toFixed(1), W_SCORE);
    const scoreColored = USE_COLOR
      ? scorePadded.replace(c.score.toFixed(1), colorScore(c.score, i))
      : scorePadded;
    const roleStr = padRight(truncate(c.role, W_ROLE), W_ROLE);
    const symStr = padRight(truncate(c.name, W_SYMBOL), W_SYMBOL);
    const locStr = padRight(truncate(loc, W_LOC), W_LOC);
    const whyStr = truncate(c.rationale || "", W_WHY);
    lines.push(`${rankStr}  ${scoreColored}  ${roleStr}  ${symStr}  ${locStr}  ${whyStr}`);
  }

  lines.push("");
  lines.push(
    dim(
      "Run with --prompt for the full LLM-grounding markdown. Run with --json for machine output.",
    ),
  );
  return lines.join("\n") + "\n";
}

/**
 * Try to reuse a previously-persisted SQLite graph instead of re-indexing.
 * On a 28k-symbol repo this turns a 17s call into ~30ms. If the file
 * doesn't exist we fall back to a full index (and persist there).
 *
 * Returns `{ db, reused }` so callers know whether to close vs. log.
 */
function reusePersistedDb(
  persist: string,
  repoRoot: string,
): { db: Db; reused: true } | null {
  const persistAbs = resolve(persist);
  if (!existsSync(persistAbs)) return null;
  const db = openDb({ persist: persistAbs });
  // Best-effort sanity check: warn if the persisted graph is from a different
  // repo. Not fatal — the caller may genuinely be querying the saved graph
  // from a different cwd.
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("repo_root") as
      | { value: string }
      | undefined;
    if (row && row.value && resolve(row.value) !== resolve(repoRoot)) {
      process.stderr.write(
        `warning: --persist graph was indexed from ${row.value}, but --repo is ${repoRoot}\n`,
      );
    }
  } catch {
    // meta table missing or shape unexpected; ignore.
  }
  return { db, reused: true };
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
  const topN =
    typeof args.flags.topN === "string" && args.flags.topN.length > 0
      ? Number(args.flags.topN)
      : undefined;
  const useLegacyWeights = args.flags["legacy-weights"] === true;

  // Resolve the output shape. `--format` is the modern flag; `--prompt` and
  // `--json` are kept as aliases so existing scripts (and the help banner
  // baseline tests) keep working. Unknown `--format` values fall back to the
  // default table — we don't error out, since the legacy aliases coexist.
  const formatFlag =
    typeof args.flags.format === "string" ? args.flags.format : "";
  const wantsPrompt = args.flags.prompt === true || formatFlag === "prompt";
  const wantsJson = args.flags.json === true || formatFlag === "json";

  // Skip prompt-formatting on the default (table) path — the runner builds a
  // multi-section markdown blob we'd otherwise discard. JSON consumers keep
  // the prompt populated for backward-compat: pre-week-6 callers serialized
  // the whole RcaResult and depended on `prompt` being non-empty.
  const result = await runRca({
    failureScope: failure,
    repoRoot,
    budget,
    format: wantsPrompt || wantsJson ? "prompt" : "structured",
    ...(persist ? { persist } : {}),
    ...(topN !== undefined && Number.isFinite(topN) ? { topN } : {}),
    ...(useLegacyWeights ? { useLegacyWeights: true } : {}),
  });
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

  if (wantsJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (wantsPrompt) {
    // Legacy behavior: dump the full markdown protocol for paste-into-LLM.
    process.stdout.write(result.prompt);
    process.stdout.write("\n");
  } else {
    // New default: ranked candidate table — the actual signal cgrca produces.
    process.stdout.write(
      renderRcaTable({
        primarySymbol: result.primarySymbol,
        causalCandidates: result.causalCandidates,
        notes: result.notes,
      }),
    );
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

/**
 * Resolve the graph DB for read-only subcommands (define / callers / callees
 * / changed). When `--persist <path>` points to an existing SQLite file we
 * reuse it (≈30ms on a 28k-symbol repo); otherwise we run a full index and,
 * if `--persist` was given but the file didn't exist, write through to it
 * so the next call is warm.
 */
async function resolveQueryDb(
  args: ParsedArgs,
  repoRoot: string,
): Promise<Db> {
  const persist =
    typeof args.flags.persist === "string" ? args.flags.persist : undefined;
  if (persist) {
    const reused = reusePersistedDb(persist, repoRoot);
    if (reused) return reused.db;
    // Fall through: file didn't exist — index the scope and persist it.
    const r = await indexScope({ repoRoot, persist });
    return r.db;
  }
  const r = await indexScope({ repoRoot });
  return r.db;
}

/**
 * If the daemon is reachable and `--no-daemon` wasn't passed, return its
 * answer; otherwise return null so the caller falls back to in-process
 * indexScope.
 */
async function tryDaemon<R>(
  args: ParsedArgs,
  method: string,
  params: Record<string, unknown>,
): Promise<R | null> {
  if (args.flags["no-daemon"] === true) return null;
  const { isDaemonUp, callDaemon } = await import("./daemon/index.js");
  if (!(await isDaemonUp())) return null;
  try {
    return await callDaemon<R>(method, params);
  } catch {
    return null;
  }
}

async function cmdDefine(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    process.stderr.write("define: missing <name>\n");
    return 2;
  }
  const repoRoot = repoRootFrom(args.flags);
  const warm = await tryDaemon<Array<{
    name: string; kind: string; file: string; startLine: number; endLine: number;
    signature: string | null; exported: boolean; language: string;
  }>>(args, "define", { repoRoot, name });
  if (warm) {
    if (warm.length === 0) {
      process.stdout.write(`no definitions for "${name}"\n`);
    } else {
      for (const d of warm) {
        process.stdout.write(
          `${d.kind} ${d.name}  ${d.file}:${d.startLine}-${d.endLine}  ${d.exported ? "exported" : "internal"}  [${d.language}]\n`,
        );
        if (d.signature) process.stdout.write(`  ${d.signature}\n`);
      }
    }
    return 0;
  }
  const db = await resolveQueryDb(args, repoRoot);
  const defs = definitionOf(db, name);
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
  db.close();
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
  const warm = await tryDaemon<unknown>(args, "callers", { repoRoot, name, depth });
  if (warm !== null) {
    process.stdout.write(JSON.stringify(warm, null, 2) + "\n");
    return 0;
  }
  const db = await resolveQueryDb(args, repoRoot);
  const tree = callersOf(db, name, { depth });
  process.stdout.write(JSON.stringify(tree, null, 2) + "\n");
  db.close();
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
  const warm = await tryDaemon<unknown>(args, "callees", { repoRoot, name, depth });
  if (warm !== null) {
    process.stdout.write(JSON.stringify(warm, null, 2) + "\n");
    return 0;
  }
  const db = await resolveQueryDb(args, repoRoot);
  const tree = calleesOf(db, name, { depth });
  process.stdout.write(JSON.stringify(tree, null, 2) + "\n");
  db.close();
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
  const warm = await tryDaemon<Array<{
    commit: string; author: string; date: string; subject: string; file: string;
  }>>(args, "changed", { repoRoot, name, sinceDays });
  if (warm !== null) {
    if (warm.length === 0) {
      process.stdout.write(`no recent commits touching "${name}" in the last ${sinceDays}d\n`);
    } else {
      for (const c of warm) {
        process.stdout.write(`${c.commit.slice(0, 8)}  ${c.author}  ${c.date}  ${c.subject}  (${c.file})\n`);
      }
    }
    return 0;
  }
  const db = await resolveQueryDb(args, repoRoot);
  const changes = recentlyChangedNear(db, name, { repoRoot, sinceDays });
  if (changes.length === 0) {
    process.stdout.write(`no recent commits touching "${name}" in the last ${sinceDays}d\n`);
  } else {
    for (const c of changes) {
      process.stdout.write(`${c.commit.slice(0, 8)}  ${c.author}  ${c.date}  ${c.subject}  (${c.file})\n`);
    }
  }
  db.close();
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
  const yes = args.flags["yes"] === true || args.flags["y"] === true;
  const { runInit, formatInitResult, planInit, formatInitPlan } = await import(
    "./init/install.js"
  );

  // Always show the plan first. `cgrca init` used to silently mutate
  // user-level configs (~/.claude.json, ~/.cursor/mcp.json, ...). A user
  // running it just to see what it does could lose state. Now we print a
  // summary and require explicit consent before writing.
  const plan = planInit({ cliPath, repoRoot });
  process.stdout.write(formatInitPlan(plan, cliPath, repoRoot));

  if (dryRun) {
    process.stdout.write("Dry run — nothing was written.\n");
    return 0;
  }

  if (!yes) {
    // Non-TTY callers must pass --yes (or --dry-run) explicitly so scripts
    // don't accidentally mutate a developer's editor configs.
    const isTty = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (!isTty) {
      process.stderr.write(
        "Refusing to mutate user config without confirmation.\n" +
          "Re-run with --yes to apply, or --dry-run to preview.\n",
      );
      return 1;
    }
    process.stdout.write("Apply changes? [y/N] ");
    const answer = await readOneLine();
    if (!/^y(es)?$/i.test(answer.trim())) {
      process.stdout.write("Aborted.\n");
      return 1;
    }
  }

  const result = runInit({ cliPath, repoRoot });
  process.stdout.write(formatInitResult(result, cliPath, repoRoot));
  return 0;
}

/**
 * Read a single line from stdin. We use `readline` rather than pulling in
 * a new dep — this is the only interactive prompt in the CLI.
 */
async function readOneLine(): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolvePromise) => {
    rl.once("line", (line) => {
      rl.close();
      resolvePromise(line);
    });
    rl.once("close", () => resolvePromise(""));
  });
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

async function cmdDaemon(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0];
  if (!sub) {
    process.stderr.write("daemon: usage: cgrca daemon <start|stop|status>\n");
    return 2;
  }
  const { isDaemonUp, callDaemon, SOCKET_PATH, readLock } = await import(
    "./daemon/index.js"
  );

  if (sub === "status") {
    const up = await isDaemonUp();
    if (!up) {
      const lock = readLock();
      process.stdout.write(
        lock
          ? `daemon: not responding (lockfile pid ${lock.pid})\n`
          : "daemon: not running\n",
      );
      return up ? 0 : 1;
    }
    const status = await callDaemon<{ pid: number; startedAt: number; repos: string[] }>(
      "status",
      {},
    );
    process.stdout.write(
      `daemon: running  pid=${status.pid}  startedAt=${new Date(status.startedAt).toISOString()}  repos=${status.repos.length}\n`,
    );
    for (const r of status.repos) process.stdout.write(`  ${r}\n`);
    return 0;
  }

  if (sub === "stop") {
    if (!(await isDaemonUp())) {
      process.stdout.write("daemon: not running\n");
      return 0;
    }
    await callDaemon("stop", {});
    process.stdout.write("daemon: stopping\n");
    return 0;
  }

  if (sub === "start") {
    if (await isDaemonUp()) {
      process.stdout.write("daemon: already running\n");
      return 0;
    }
    // Fork ourselves with `__daemon-run` so the new process becomes the
    // server and detaches. We use the same node + argv0 so PATH lookups
    // don't drift between launcher and child.
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const selfPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [selfPath, "__daemon-run"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // Wait up to 3s for the socket to come up.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (await isDaemonUp()) {
        process.stdout.write(`daemon: started  socket=${SOCKET_PATH}\n`);
        return 0;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    process.stderr.write("daemon: failed to start within 3s\n");
    return 1;
  }

  process.stderr.write(`daemon: unknown subcommand: ${sub}\n`);
  return 2;
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

  // Internal entrypoint used by `cgrca daemon start` after fork. Not in
  // USAGE: it's a private contract between the launcher and the child.
  if (cmd === "__daemon-run") {
    const { startDaemon } = await import("./daemon/index.js");
    const handle = startDaemon({});
    await handle.ready;
    process.on("SIGTERM", () => { void handle.stop(); });
    process.on("SIGINT", () => { void handle.stop(); });
    // Block forever — node will exit when the server.close() in stop() drains.
    await new Promise<void>(() => { /* never resolves */ });
    return 0;
  }

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
    case "daemon":
      return cmdDaemon(args);
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
