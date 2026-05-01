import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/init/install.js";

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
