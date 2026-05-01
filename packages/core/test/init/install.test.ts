import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runInit, planInit, formatInitPlan } from "../../src/init/install.js";

function newSandbox(): { home: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "cgrca-init-"));
  return { home: join(root, "home"), repo: join(root, "repo") };
}

describe("runInit", () => {
  it("writes Cursor + Claude Code MCP entries when those config dirs exist; leaves siblings alone", () => {
    const { home, repo } = newSandbox();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    // Pre-populate Cursor with an unrelated MCP server. We must preserve it.
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          something: { command: "echo", args: ["hi"] },
        },
      }),
      "utf8",
    );
    // Claude Code: empty file, but home dir exists. shouldWrite() should still pick it up.
    writeFileSync(join(home, ".claude.json"), "");
    mkdirSync(repo, { recursive: true });

    const result = runInit({
      cliPath: "/path/to/cgrca/cli.js",
      repoRoot: repo,
      homeOverride: home,
    });

    const writtenNames = result.written.map((w) => w.target).sort();
    expect(writtenNames).toContain("Cursor");
    expect(writtenNames).toContain("Claude Code");

    const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    // Pre-existing entry preserved.
    expect(cursor.mcpServers.something).toEqual({ command: "echo", args: ["hi"] });
    // cgrca entry written with the right shape.
    expect(cursor.mcpServers.cgrca?.command).toBe("node");
    expect(cursor.mcpServers.cgrca?.args).toContain("mcp");
    expect(cursor.mcpServers.cgrca?.args).toContain(repo);

    // AGENTS.md was created.
    expect(result.agentsMd.written).toBe(true);
    const agents = readFileSync(result.agentsMd.path, "utf8");
    expect(agents).toContain("cgrca_rcaPrompt");
    expect(agents).toContain("AGENTS.md");
  });

  it("re-running is idempotent — cgrca entry is replaced, not duplicated", () => {
    const { home, repo } = newSandbox();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(repo, { recursive: true });

    runInit({ cliPath: "/v1/cli.js", repoRoot: repo, homeOverride: home });
    runInit({ cliPath: "/v2/cli.js", repoRoot: repo, homeOverride: home });

    const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(Object.keys(cursor.mcpServers)).toEqual(["cgrca"]);
    expect(cursor.mcpServers.cgrca?.args[0]).toBe("/v2/cli.js");
  });

  it("skips editors not detected on the host", () => {
    const { home, repo } = newSandbox();
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    // No editor configs at all.

    const result = runInit({
      cliPath: "/path/to/cgrca/cli.js",
      repoRoot: repo,
      homeOverride: home,
    });

    expect(result.written.length).toBeGreaterThanOrEqual(0);
    // At least one editor will be skipped (we have a tmp home).
    expect(result.skipped.length).toBeGreaterThan(0);
    for (const s of result.skipped) {
      expect(s.reason).toBe("not detected");
    }
    // AGENTS.md still gets written even when no editor configs exist.
    expect(result.agentsMd.written).toBe(true);
  });

  it("dry-run doesn't actually write anything", () => {
    const { home, repo } = newSandbox();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(repo, { recursive: true });

    const result = runInit({
      cliPath: "/path/to/cgrca/cli.js",
      repoRoot: repo,
      homeOverride: home,
      dryRun: true,
    });

    expect(result.written.length).toBeGreaterThan(0);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(existsSync(result.agentsMd.path)).toBe(false);
  });

  it("planInit reports update vs create vs skip without writing", () => {
    const { home, repo } = newSandbox();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    // Existing Cursor config — should be flagged as 'update'.
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: {} }),
      "utf8",
    );
    mkdirSync(repo, { recursive: true });

    const plan = planInit({
      cliPath: "/path/to/cli.js",
      repoRoot: repo,
      homeOverride: home,
    });
    const cursor = plan.items.find((i) => i.target === "Cursor");
    expect(cursor?.action).toBe("update");
    expect(cursor?.existing).toBe(true);
    // Editors with neither file nor parent dir should be skipped.
    const skipped = plan.items.filter((i) => i.action === "skip");
    expect(skipped.length).toBeGreaterThan(0);
    // AGENTS.md doesn't exist yet, so it's a create.
    expect(plan.agentsMd.action).toBe("create");
    // Plan must not write anything.
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);

    // Sanity: format renders without throwing.
    const txt = formatInitPlan(plan, "/path/to/cli.js", repo);
    expect(txt).toContain("planned changes");
    expect(txt).toContain("Cursor");
  });

  it("doesn't overwrite an existing AGENTS.md", () => {
    const { home, repo } = newSandbox();
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "# my agents file\n", "utf8");

    const result = runInit({
      cliPath: "/path/to/cgrca/cli.js",
      repoRoot: repo,
      homeOverride: home,
    });

    expect(result.agentsMd.written).toBe(false);
    expect(readFileSync(result.agentsMd.path, "utf8")).toBe("# my agents file\n");
    expect(result.notes.some((n) => n.includes("already exists"))).toBe(true);
  });
});

// CLI-level confirmation behavior. We spawn the cli via `tsx` so we exercise
// the actual flag parsing + TTY check + readline path. HOME is overridden to
// a sandbox so we never touch the developer's real editor configs.
describe("cgrca init CLI confirmation gate", () => {
  const here = resolve(__dirname, "..");
  const CLI = resolve(here, "..", "src", "cli.ts");

  function runInitCli(
    args: string[],
    home: string,
    input?: string,
  ): { stdout: string; stderr: string; status: number | null } {
    const r = spawnSync("npx", ["tsx", CLI, "init", ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, HOME: home, NODE_OPTIONS: "" },
      ...(input !== undefined ? { input } : {}),
    });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status };
  }

  it("non-TTY without --yes exits 1 and writes nothing", () => {
    const { home, repo } = newSandbox();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(repo, { recursive: true });

    const r = runInitCli([repo], home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--yes");
    expect(r.stdout).toContain("planned changes");
    // Crucially: no files were written.
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
  });

  it("--dry-run prints the plan and exits 0 without writing", () => {
    const { home, repo } = newSandbox();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(repo, { recursive: true });

    const r = runInitCli([repo, "--dry-run"], home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Dry run");
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
  });

  it("--yes applies changes", () => {
    const { home, repo } = newSandbox();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(repo, { recursive: true });

    const r = runInitCli([repo, "--yes"], home);
    expect(r.status).toBe(0);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
    const cursor = JSON.parse(
      readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(cursor.mcpServers.cgrca).toBeDefined();
  });
});
