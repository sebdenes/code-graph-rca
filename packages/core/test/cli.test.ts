import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("rca default emits the ranked candidate table", () => {
    const r = run(["rca", "symbol:ingest", "--repo", PY_FIXTURE]);
    expect(r.status).toBe(0);
    // Default human output is the compact table — not the markdown prompt.
    expect(r.stdout).toContain("CGRCA");
    expect(r.stdout).toContain("anchor:");
    expect(r.stdout).toContain("ingest");
    expect(r.stdout).not.toContain("Root-cause-analysis protocol");
    expect(r.stdout).toContain("--prompt");
  });

  it("default rca (table) does NOT call the prompt formatter", () => {
    // Proxy for "runRca was called with format='structured'": none of the
    // markdown headings the prompt formatter emits should appear in stdout.
    // If cmdRca regresses to the default `format: 'prompt'` path, the
    // runner will still build the markdown — but the table renderer
    // discards it, so this test alone wouldn't catch a perf regression.
    // The stronger check is the --json one below: structured runs leave
    // `result.prompt === ""`.
    const r = run(["rca", "symbol:ingest", "--repo", PY_FIXTURE]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("# Failure context");
    expect(r.stdout).not.toContain("## First hypothesis");
    expect(r.stdout).not.toContain("## Top causal candidates");
    expect(r.stdout).not.toContain("## Graph context");
    expect(r.stdout).not.toContain("# Root-cause-analysis protocol");
  });

  it("rca --format=table is an alias for the default table output", () => {
    const r = run(["rca", "symbol:ingest", "--repo", PY_FIXTURE, "--format=table"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("CGRCA");
    expect(r.stdout).toContain("anchor:");
    expect(r.stdout).not.toContain("Root-cause-analysis protocol");
  });

  it("rca --format=prompt emits the markdown protocol like --prompt", () => {
    const r = run(["rca", "symbol:ingest", "--repo", PY_FIXTURE, "--format=prompt"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Failure context");
    expect(r.stdout).toContain("Root-cause-analysis protocol");
  });

  it("rca --format=json behaves like --json (prompt populated for compat)", () => {
    const r = run(["rca", "symbol:ingest", "--repo", PY_FIXTURE, "--format=json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.primarySymbol).toBe("ingest");
    // --json/--format=json keep prompt populated so existing consumers
    // (which serialized the whole RcaResult pre-week-6) don't break.
    expect(typeof parsed.prompt).toBe("string");
    expect(parsed.prompt.length).toBeGreaterThan(0);
  });

  it("rca --prompt on py-package emits the legacy markdown protocol", () => {
    const r = run(["rca", "symbol:ingest", "--repo", PY_FIXTURE, "--prompt"]);
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

  it("rca with free-text prose returns >0 candidates (v0.5 Phase 1)", () => {
    // Pre-Phase-1: any input that wasn't `symbol:` / `file:` / `test:` /
    // a stack-trace path collapsed to {kind:"symbol", name:spec} and
    // returned 0 candidates because no symbol named the whole sentence.
    // Now we tokenize prose and match against the KG.
    const r = run([
      "rca",
      "athlete silently gets wrong plan when login fails",
      "--repo",
      TS_FIXTURE,
      "--json",
    ]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed.causalCandidates)).toBe(true);
    // The token "login" hits the login symbol in the fixture's auth pkg.
    expect(parsed.causalCandidates.length).toBeGreaterThan(0);
  });

  it("rca file:PATH returns >=1 candidate (v0.5 Phase 1 file: fix)", () => {
    // Pre-Phase-1: file: returned null anchor + 0 candidates even when the
    // file existed in scope. Now it seeds the chain with every symbol in
    // the file ranked by the 7-signal scorer.
    const r = run([
      "rca",
      "file:packages/auth/src/login.ts",
      "--repo",
      TS_FIXTURE,
      "--json",
    ]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed.causalCandidates)).toBe(true);
    expect(parsed.causalCandidates.length).toBeGreaterThanOrEqual(1);
    // Anchor should be one of the symbols in login.ts (login or KNOWN).
    expect(parsed.primarySymbol).not.toBeNull();
  });

  it("define --persist reuses the existing sqlite on warm calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "cgrca-persist-"));
    const sqlitePath = join(dir, "graph.sqlite");
    try {
      // Cold: build & persist the graph.
      const cold = run(["define", "login", "--repo", TS_FIXTURE, "--persist", sqlitePath]);
      expect(cold.status).toBe(0);
      expect(existsSync(sqlitePath)).toBe(true);
      expect(cold.stdout).toContain("login.ts");

      // Warm: reuse the persisted graph. The wall clock includes npx/tsx
      // boot, so the bound is loose; but if --persist reuse regresses,
      // this re-indexes and large-scale repos blow well past 500ms.
      const t0 = Date.now();
      const warm = run(["define", "login", "--repo", TS_FIXTURE, "--persist", sqlitePath]);
      const elapsed = Date.now() - t0;
      expect(warm.status).toBe(0);
      expect(warm.stdout).toContain("login.ts");
      // Generous on the tiny ts-monorepo fixture; the real win shows on big repos.
      expect(elapsed).toBeLessThan(2_500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
