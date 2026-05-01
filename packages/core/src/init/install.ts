/**
 * `cgrca init` implementation.
 *
 * Detects MCP-aware coding agents on the host and registers cgrca as an
 * MCP server with each. Writes AGENTS.md at the repo root. Prints a
 * summary plus manual-paste snippets for any agents we don't auto-write.
 *
 * Design choices:
 *  - Idempotent: re-running updates the cgrca entry in place; doesn't
 *    duplicate or wipe other servers.
 *  - Non-destructive: never deletes existing MCP entries we don't own.
 *  - Cross-editor: writes to whichever editor configs we find, prints
 *    snippets for the rest. The agent landscape changes weekly — we
 *    don't try to know every one.
 *
 * Supported targets (auto-write):
 *  - Cursor:        ~/.cursor/mcp.json
 *  - Claude Code:   ~/.claude.json (mcpServers)
 *  - Cline (VS Code): ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json (macOS)
 *  - Continue:      ~/.continue/config.json (mcpServers array)
 *  - Windsurf:      ~/.codeium/windsurf/mcp_config.json
 *
 * For unknown clients we print a copy-pasteable snippet at the end.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { renderAgentsMd } from "./agents-md.js";

export interface InitOptions {
  /** Path to the cgrca CLI entry that targets will spawn. */
  cliPath: string;
  /** Repo root we want the agents to ground against. */
  repoRoot: string;
  /** When true, don't actually write — just print what would happen. */
  dryRun?: boolean;
  /** Override homedir (testing). */
  homeOverride?: string;
}

export interface InitResult {
  written: Array<{ target: string; path: string }>;
  skipped: Array<{ target: string; path: string; reason: string }>;
  agentsMd: { path: string; written: boolean };
  notes: string[];
}

interface Target {
  name: string;
  /** Path to the JSON config we'd modify. Resolved at run time. */
  path: string;
  /**
   * How to mutate the JSON. Receives the parsed object (or `null` if the
   * file doesn't exist) and returns the object to write back. Should be
   * idempotent.
   */
  upsert: (current: Record<string, unknown> | null) => Record<string, unknown>;
}

/** The MCP server entry we install. */
function serverEntry(cliPath: string, repoRoot: string): Record<string, unknown> {
  return {
    command: "node",
    args: [cliPath, "mcp", repoRoot],
  };
}

/** Insert/update the cgrca entry under `mcpServers.cgrca`, never touching
 *  sibling entries. Used by Cursor / Claude / Windsurf-style configs. */
function upsertMcpServersObject(
  cliPath: string,
  repoRoot: string,
): (current: Record<string, unknown> | null) => Record<string, unknown> {
  return (current) => {
    const next: Record<string, unknown> = { ...(current ?? {}) };
    const servers = (next.mcpServers as Record<string, unknown> | undefined) ?? {};
    next.mcpServers = { ...servers, cgrca: serverEntry(cliPath, repoRoot) };
    return next;
  };
}

/** Continue uses an array under `mcpServers` with named entries.
 *  We dedupe by `name === "cgrca"` and replace, leaving others alone. */
function upsertContinueArray(
  cliPath: string,
  repoRoot: string,
): (current: Record<string, unknown> | null) => Record<string, unknown> {
  return (current) => {
    const next: Record<string, unknown> = { ...(current ?? {}) };
    const arr = Array.isArray(next.mcpServers) ? [...(next.mcpServers as unknown[])] : [];
    const filtered = arr.filter((s) => {
      if (s !== null && typeof s === "object" && "name" in s) {
        return (s as { name?: unknown }).name !== "cgrca";
      }
      return true;
    });
    filtered.push({ name: "cgrca", ...serverEntry(cliPath, repoRoot) });
    next.mcpServers = filtered;
    return next;
  };
}

function clineConfigPath(home: string): string {
  // VS Code's globalStorage location for Cline (`saoudrizwan.claude-dev`).
  // Linux/Windows have different parents — we only attempt the Mac path
  // for the auto-detect; other OSes fall through to the manual snippet.
  const p = platform();
  if (p === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev",
      "settings",
      "cline_mcp_settings.json",
    );
  }
  if (p === "linux") {
    return join(
      home,
      ".config",
      "Code",
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev",
      "settings",
      "cline_mcp_settings.json",
    );
  }
  // Windows fallback (best effort)
  return join(
    home,
    "AppData",
    "Roaming",
    "Code",
    "User",
    "globalStorage",
    "saoudrizwan.claude-dev",
    "settings",
    "cline_mcp_settings.json",
  );
}

function buildTargets(home: string, cliPath: string, repoRoot: string): Target[] {
  return [
    {
      name: "Cursor",
      path: join(home, ".cursor", "mcp.json"),
      upsert: upsertMcpServersObject(cliPath, repoRoot),
    },
    {
      name: "Claude Code",
      path: join(home, ".claude.json"),
      upsert: upsertMcpServersObject(cliPath, repoRoot),
    },
    {
      name: "Cline (VS Code)",
      path: clineConfigPath(home),
      upsert: upsertMcpServersObject(cliPath, repoRoot),
    },
    {
      name: "Continue",
      path: join(home, ".continue", "config.json"),
      upsert: upsertContinueArray(cliPath, repoRoot),
    },
    {
      name: "Windsurf",
      path: join(home, ".codeium", "windsurf", "mcp_config.json"),
      upsert: upsertMcpServersObject(cliPath, repoRoot),
    },
  ];
}

function readJsonOr(
  path: string,
  fallback: Record<string, unknown> | null,
): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return fallback;
    const txt = readFileSync(path, "utf8");
    if (txt.trim().length === 0) return fallback;
    return JSON.parse(txt) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * Heuristic: should we offer to write to this target? Yes only if:
 *  - the config file already exists (the editor is installed AND configured), OR
 *  - the IMMEDIATE parent dir exists (the editor app dropped a marker dir).
 *
 * We deliberately do NOT walk ancestors. `~/` always exists; doing so
 * would falsely "detect" every editor on every machine.
 */
function shouldWrite(targetPath: string): boolean {
  if (existsSync(targetPath)) return true;
  const parent = dirname(targetPath);
  if (!existsSync(parent)) return false;
  try {
    return statSync(parent).isDirectory();
  } catch {
    return false;
  }
}

export function runInit(opts: InitOptions): InitResult {
  const home = opts.homeOverride ?? homedir();
  const cliPath = resolve(opts.cliPath);
  const repoRoot = resolve(opts.repoRoot);
  const dryRun = opts.dryRun ?? false;

  const targets = buildTargets(home, cliPath, repoRoot);
  const written: InitResult["written"] = [];
  const skipped: InitResult["skipped"] = [];
  const notes: string[] = [];

  for (const t of targets) {
    if (!shouldWrite(t.path)) {
      skipped.push({ target: t.name, path: t.path, reason: "not detected" });
      continue;
    }
    try {
      const current = readJsonOr(t.path, null);
      const next = t.upsert(current);
      if (!dryRun) writeJson(t.path, next);
      written.push({ target: t.name, path: t.path });
    } catch (err) {
      skipped.push({
        target: t.name,
        path: t.path,
        reason: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // AGENTS.md at the repo root.
  const agentsPath = join(repoRoot, "AGENTS.md");
  let agentsMdWritten = false;
  if (!existsSync(agentsPath)) {
    const content = renderAgentsMd({
      cliPath,
      repoName: agentsPath.split("/").slice(-2, -1)[0] ?? "this project",
    });
    if (!dryRun) writeFileSync(agentsPath, content, "utf8");
    agentsMdWritten = true;
  } else {
    notes.push(`AGENTS.md already exists at ${agentsPath} — left untouched.`);
  }

  return {
    written,
    skipped,
    agentsMd: { path: agentsPath, written: agentsMdWritten },
    notes,
  };
}

/**
 * Pretty-print the result for the CLI. Returns the text to write to stderr/stdout.
 */
export function formatInitResult(
  result: InitResult,
  cliPath: string,
  repoRoot: string,
): string {
  const lines: string[] = [];
  lines.push("cgrca init");
  lines.push(`  repo: ${repoRoot}`);
  lines.push(`  cli:  ${cliPath}`);
  lines.push("");
  if (result.written.length === 0) {
    lines.push("No editor MCP configs detected.");
  } else {
    lines.push("Wrote MCP entries to:");
    for (const w of result.written) {
      lines.push(`  ✓ ${w.target.padEnd(18)} ${w.path}`);
    }
  }
  if (result.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped:");
    for (const s of result.skipped) {
      lines.push(`  · ${s.target.padEnd(18)} ${s.reason}`);
    }
  }
  lines.push("");
  if (result.agentsMd.written) {
    lines.push(`Wrote ${result.agentsMd.path}`);
  } else {
    lines.push(`AGENTS.md untouched at ${result.agentsMd.path}`);
  }
  for (const n of result.notes) lines.push(`  · ${n}`);
  lines.push("");
  lines.push("To register with any editor we missed, paste this into its MCP config:");
  lines.push("");
  lines.push("  {");
  lines.push("    \"mcpServers\": {");
  lines.push("      \"cgrca\": {");
  lines.push("        \"command\": \"node\",");
  lines.push(`        \"args\": [\"${cliPath}\", \"mcp\", \"${repoRoot}\"]`);
  lines.push("      }");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  return lines.join("\n");
}
