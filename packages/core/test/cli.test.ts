import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..");
const TS_FIXTURE = join(REPO, "test", "fixtures", "ts-monorepo");
const PY_FIXTURE = join(REPO, "test", "fixtures", "py-package");
const CLI = join(REPO, "src", "cli.ts");

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("npx", ["tsx", CLI, ...args], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe("cli smoke", () => {
  it("version", () => {
    const r = run(["version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("define on ts-monorepo finds login", () => {
    const r = run(["define", "login", "--repo", TS_FIXTURE]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("login.ts");
    expect(r.stdout).toContain("function login");
  });

  it("rca symbol:ingest on py-package emits prompt with the protocol", () => {
    const r = run(["rca", "symbol:ingest", "--repo", PY_FIXTURE]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Failure context");
    expect(r.stdout).toContain("Graph context");
    expect(r.stdout).toContain("Root-cause-analysis protocol");
    expect(r.stdout).toContain("ingest");
  });

  it("rca --json emits parseable JSON", () => {
    const r = run(["rca", "symbol:ingest", "--repo", PY_FIXTURE, "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.primarySymbol).toBe("ingest");
    expect(typeof parsed.prompt).toBe("string");
    expect(Array.isArray(parsed.queries)).toBe(true);
  });

  it("unknown command exits 2", () => {
    const r = run(["bogus"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown command");
  });
});
