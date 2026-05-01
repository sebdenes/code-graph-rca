import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRca } from "code-graph-rca";

/** Create a small TS git repo with a function `victim` called by `caller`. */
export function makeFixtureRepo(): {
  root: string;
  sqlite: string;
  initialSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), "cgrca-ui-fix-"));

  // a.ts has the victim and a sibling.
  writeFileSync(
    join(root, "a.ts"),
    `export function victim(x: number): number {
  return x + 1;
}

export class Greeter {
  greet(name: string): string {
    return \`hi \${name}\`;
  }
}
`,
  );
  // b.ts calls victim.
  writeFileSync(
    join(root, "b.ts"),
    `import { victim, Greeter } from "./a.js";

export function caller(): number {
  const g = new Greeter();
  g.greet("world");
  return victim(41);
}

export function caller2(): number {
  return victim(2) + victim(3);
}
`,
  );
  // a test file in tests/ that mentions victim.
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(
    join(root, "tests", "victim_test.ts"),
    `import { victim } from "../a.js";

export function testVictim(): void {
  if (victim(1) !== 2) throw new Error("nope");
}
`,
  );

  // Init git, commit, capture sha.
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Tester",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "Tester",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, env });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root, env });
  spawnSync("git", ["add", "."], { cwd: root, env });
  spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: root, env });
  const shaRes = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  const initialSha = (shaRes.stdout ?? "").trim();
  return { root, sqlite: join(root, "session.sqlite"), initialSha };
}

/** Run RCA against the fixture and persist the sqlite + sidecar. */
export async function persistRca(root: string, sqlite: string): Promise<void> {
  const result = await runRca({
    failureScope: { kind: "symbol", name: "victim" },
    repoRoot: root,
    persist: sqlite,
  });
  // Mirror what the CLI does: write the sidecar and stamp meta.
  writeFileSync(`${sqlite}.rca.json`, JSON.stringify(result, null, 2));
  // Stamp meta with primary_symbol since runRca's persist path opens its own DB
  // and we need it for the SessionSummary contract.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = (await import("better-sqlite3")).default;
  const stamp = new Database(sqlite);
  stamp.exec(
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const ins = stamp.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
  );
  ins.run("repo_root", root);
  ins.run("primary_symbol", result.primarySymbol ?? "");
  stamp.close();
}
