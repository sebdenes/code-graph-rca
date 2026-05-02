import { describe, it, expect } from "vitest";
import { openDb, type Db } from "../../src/graph/db.js";
import {
  tokenizeFailure,
  matchTokensAgainstKg,
  splitCompound,
} from "../../src/rca/textmode.js";

/**
 * Build a tiny in-memory KG. Same shape the causal.test.ts buildDb helper
 * uses, but with `signature` and `imports` so we can exercise all three
 * matcher buckets.
 */
function buildDb(spec: {
  files: Array<{ path: string; subsystem?: string }>;
  symbols: Array<{
    file: string;
    name: string;
    kind?: string;
    signature?: string | null;
  }>;
  imports?: Array<{ file: string; localName: string; module: string }>;
}): Db {
  const db = openDb({});
  const insFile = db.prepare(
    "INSERT INTO files (path, language, subsystem, loc) VALUES (?, 'typescript', ?, 0)",
  );
  const insSym = db.prepare(
    "INSERT INTO symbols (file_id, name, kind, parent_id, start_line, end_line, signature, exported) VALUES (?, ?, ?, NULL, 1, 10, ?, 0)",
  );
  const insImport = db.prepare(
    "INSERT INTO imports (file_id, local_name, source_module, source_name, kind) VALUES (?, ?, ?, ?, 'named')",
  );
  const fileIds = new Map<string, number>();
  for (const f of spec.files) {
    const r = insFile.run(f.path, f.subsystem ?? "core");
    fileIds.set(f.path, r.lastInsertRowid as number);
  }
  for (const s of spec.symbols) {
    const fid = fileIds.get(s.file);
    if (fid === undefined) throw new Error(`unknown file ${s.file}`);
    insSym.run(fid, s.name, s.kind ?? "function", s.signature ?? null);
  }
  for (const imp of spec.imports ?? []) {
    const fid = fileIds.get(imp.file);
    if (fid === undefined) throw new Error(`unknown file ${imp.file}`);
    insImport.run(fid, imp.localName, imp.module, imp.localName);
  }
  return db;
}

describe("tokenizeFailure", () => {
  it("splits prose into identifier tokens, drops stopwords + short tokens", () => {
    const t = tokenizeFailure(
      "athlete silently gets the wrong plan when sport is cycling",
    );
    expect(t.identifierTokens).toEqual([
      "athlete",
      "silently",
      "gets",
      "wrong",
      "plan",
      "sport",
      "cycling",
    ]);
    // No literal tokens — nothing was quoted.
    expect(t.literalTokens).toEqual([]);
    // Body text is preserved verbatim.
    expect(t.bodyText).toBe(
      "athlete silently gets the wrong plan when sport is cycling",
    );
  });

  it("keeps snake_case + camelCase identifiers as single tokens", () => {
    const t = tokenizeFailure("calling get_plan_for_user from buildSession");
    // `calling`, `from` survive (>=3 chars, not stopwords).
    expect(t.identifierTokens).toContain("get_plan_for_user");
    expect(t.identifierTokens).toContain("buildSession");
    expect(t.identifierTokens).toContain("calling");
    // `from` is dropped — English/Python stopword.
    expect(t.identifierTokens).not.toContain("from");
  });

  it("extracts double-quoted literals (including short ones >=2 chars)", () => {
    const t = tokenizeFailure('user reports "10k" total when sport == "marathon"');
    expect(t.literalTokens).toEqual(["10k", "marathon"]);
    // The literal regions are blanked out so 'marathon' doesn't double up
    // as an identifier token.
    expect(t.identifierTokens).not.toContain("marathon");
    expect(t.identifierTokens).not.toContain("10k");
  });

  it("extracts single-quoted literals", () => {
    const t = tokenizeFailure("the env var 'AUTH_TIMEOUT_MS' is unset");
    expect(t.literalTokens).toEqual(["AUTH_TIMEOUT_MS"]);
  });

  it("dedupes repeated tokens and preserves first-seen order", () => {
    const t = tokenizeFailure("login fails. login retries. then login again.");
    expect(t.identifierTokens).toEqual(["login", "fails", "retries", "again"]);
  });

  it("drops 1- and 2-char identifier tokens, keeps 3+ ones", () => {
    const t = tokenizeFailure("a bb ccc dddd");
    expect(t.identifierTokens).toEqual(["ccc", "dddd"]);
  });

  it("preserves case so case-sensitive symbol matching works", () => {
    const t = tokenizeFailure("Login class crashes inside loginUser");
    expect(t.identifierTokens).toEqual(["Login", "class", "crashes", "inside", "loginUser"]);
  });

  it("returns empty buckets for empty input", () => {
    const t = tokenizeFailure("");
    expect(t.identifierTokens).toEqual([]);
    expect(t.literalTokens).toEqual([]);
  });

  it("survives only-stopwords input", () => {
    const t = tokenizeFailure("the and or but not yes when then this that");
    expect(t.identifierTokens).toEqual([]);
  });
});

describe("matchTokensAgainstKg", () => {
  it("name-match: surfaces a symbol whose name appears as an identifier token", () => {
    const db = buildDb({
      files: [{ path: "src/login.ts" }],
      symbols: [
        { file: "src/login.ts", name: "login" },
        { file: "src/login.ts", name: "logout" },
      ],
    });
    const matches = matchTokensAgainstKg(
      db,
      tokenizeFailure("the login flow is broken"),
    );
    expect(matches.length).toBeGreaterThan(0);
    const top = matches[0]!;
    expect(top.symbolName).toBe("login");
    expect(top.nameMatches).toBe(1);
    // logout shouldn't appear: no token matched.
    expect(matches.find((m) => m.symbolName === "logout")).toBeUndefined();
    db.close();
  });

  it("body-match: literal token in symbol signature lifts the score", () => {
    const db = buildDb({
      files: [{ path: "src/plans.ts" }],
      symbols: [
        {
          file: "src/plans.ts",
          name: "buildPlan",
          signature: 'function buildPlan(sport: string = "marathon")',
        },
        {
          file: "src/plans.ts",
          name: "validate",
          signature: "function validate(input: unknown)",
        },
      ],
    });
    const matches = matchTokensAgainstKg(
      db,
      tokenizeFailure('failure when sport is "marathon"'),
    );
    expect(matches.length).toBeGreaterThan(0);
    const buildPlanMatch = matches.find((m) => m.symbolName === "buildPlan");
    expect(buildPlanMatch).toBeDefined();
    // Two body hits: the literal "marathon" (default value) AND the
    // identifier sub-word "sport" matching the param name in the signature.
    expect(buildPlanMatch!.bodyMatches).toBe(2);
    db.close();
  });

  it("import-match: tokens that hit imports.local_name promote symbols in that file", () => {
    const db = buildDb({
      files: [
        { path: "src/login.ts" },
        { path: "src/unrelated.ts" },
      ],
      symbols: [
        { file: "src/login.ts", name: "login" },
        { file: "src/login.ts", name: "buildSession" },
        { file: "src/unrelated.ts", name: "noise" },
      ],
      imports: [
        { file: "src/login.ts", localName: "Session", module: "./session" },
      ],
    });
    const matches = matchTokensAgainstKg(
      db,
      tokenizeFailure("Session looks wrong"),
    );
    // Both login + buildSession sit in the file that imports Session,
    // so both get the import-match credit.
    const names = matches.map((m) => m.symbolName).sort();
    expect(names).toContain("login");
    expect(names).toContain("buildSession");
    // noise lives in a different file with no Session import.
    expect(names).not.toContain("noise");
    db.close();
  });

  it("name-match weighs more than import-match (3.0 vs 0.5)", () => {
    const db = buildDb({
      files: [
        { path: "src/login.ts" },
        { path: "src/other.ts" },
      ],
      symbols: [
        { file: "src/login.ts", name: "login" },
        { file: "src/other.ts", name: "wrapper" },
      ],
      imports: [
        // wrapper's file imports `login` as a local name — so 'login' as a
        // token gives wrapper the import bonus, but `login` itself should
        // still rank above wrapper because name=3 > import=0.5.
        { file: "src/other.ts", localName: "login", module: "./login" },
      ],
    });
    const matches = matchTokensAgainstKg(
      db,
      tokenizeFailure("login is broken"),
    );
    expect(matches[0]!.symbolName).toBe("login");
    const loginScore = matches.find((m) => m.symbolName === "login")!.totalScore;
    const wrapperScore = matches.find((m) => m.symbolName === "wrapper")!.totalScore;
    expect(loginScore).toBeGreaterThan(wrapperScore);
  });

  it("returns empty list when no tokens match", () => {
    const db = buildDb({
      files: [{ path: "src/a.ts" }],
      symbols: [{ file: "src/a.ts", name: "alpha" }],
    });
    const matches = matchTokensAgainstKg(
      db,
      tokenizeFailure("nothing relevant here"),
    );
    expect(matches).toEqual([]);
    db.close();
  });

  it("returns empty for empty-token input", () => {
    const db = buildDb({
      files: [{ path: "src/a.ts" }],
      symbols: [{ file: "src/a.ts", name: "alpha" }],
    });
    const matches = matchTokensAgainstKg(db, tokenizeFailure(""));
    expect(matches).toEqual([]);
    db.close();
  });

  it("LIKE wildcards in literal tokens are escaped (no false positives)", () => {
    const db = buildDb({
      files: [{ path: "src/a.ts" }],
      symbols: [
        {
          file: "src/a.ts",
          name: "literalMatch",
          signature: "function literalMatch() // 50% off",
        },
        {
          file: "src/a.ts",
          name: "noMatch",
          signature: "function noMatch()",
        },
      ],
    });
    // The literal "50%" should match literalMatch (LIKE %50\%%) but
    // shouldn't accidentally match every other signature via the % wildcard.
    const matches = matchTokensAgainstKg(
      db,
      tokenizeFailure('the off-by-one was "50%"'),
    );
    const names = matches.map((m) => m.symbolName);
    expect(names).toContain("literalMatch");
    expect(names).not.toContain("noMatch");
    db.close();
  });

  it("name-match is case-sensitive (Login != login)", () => {
    const db = buildDb({
      files: [{ path: "src/a.ts" }],
      symbols: [
        { file: "src/a.ts", name: "Login", kind: "class" },
        { file: "src/a.ts", name: "login", kind: "function" },
      ],
    });
    // Lowercase token only hits the lowercase symbol.
    const matches = matchTokensAgainstKg(
      db,
      tokenizeFailure("login flow"),
    );
    const top = matches[0]!;
    expect(top.symbolName).toBe("login");
    db.close();
  });

  it("totalScore is normalized into [0, 1]", () => {
    const db = buildDb({
      files: [{ path: "src/a.ts" }],
      symbols: [{ file: "src/a.ts", name: "alpha" }],
    });
    const matches = matchTokensAgainstKg(db, tokenizeFailure("alpha"));
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m.totalScore).toBeGreaterThanOrEqual(0);
      expect(m.totalScore).toBeLessThanOrEqual(1);
    }
    db.close();
  });
});

describe("splitCompound", () => {
  it("splits camelCase at lower→upper boundaries", () => {
    expect(splitCompound("sendMessage")).toEqual(["send", "message"]);
    expect(splitCompound("buildPlan")).toEqual(["build", "plan"]);
  });

  it("splits snake_case on underscores", () => {
    expect(splitCompound("send_message_safe")).toEqual(["send", "message", "safe"]);
    expect(splitCompound("_strip_markdown")).toEqual(["strip", "markdown"]);
    expect(splitCompound("fetch_planned_events")).toEqual(["fetch", "planned", "events"]);
  });

  it("lowercases pieces and dedupes", () => {
    expect(splitCompound("ABCThing")).toEqual(["abc", "thing"]);
    // Same piece should not appear twice (case-insensitive dedupe).
    expect(splitCompound("Foo_FOO_foo")).toEqual(["foo"]);
  });

  it("drops sub-words shorter than 3 chars", () => {
    // "is" / "to" / "Id" / "Ok" → too noisy. "get" survives (len 3).
    expect(splitCompound("isOk")).toEqual([]);
    expect(splitCompound("getId")).toEqual(["get"]);
    expect(splitCompound("isMarathon")).toEqual(["marathon"]);
  });

  it("returns empty for sub-3-char input", () => {
    expect(splitCompound("id")).toEqual([]);
    expect(splitCompound("")).toEqual([]);
  });

  it("returns single piece for already-atomic identifiers", () => {
    expect(splitCompound("login")).toEqual(["login"]);
    expect(splitCompound("Login")).toEqual(["login"]);
  });
});

describe("matchTokensAgainstKg — substring + body content (Phase 2 retrieval lift)", () => {
  it("camelCase prose token finds snake_case symbol via substring", () => {
    // Prose says "sendMessage", code defines `send_message_safe`.
    // Pre-Phase-2 matcher missed this entirely (exact-name only).
    const db = buildDb({
      files: [{ path: "src/telegram.py" }],
      symbols: [
        { file: "src/telegram.py", name: "send_message_safe" },
        { file: "src/telegram.py", name: "_strip_markdown" },
        { file: "src/telegram.py", name: "unrelated_helper" },
      ],
    });
    const matches = matchTokensAgainstKg(
      db,
      tokenizeFailure("sendMessage fails on malformed Markdown"),
    );
    const names = matches.map((m) => m.symbolName);
    expect(names).toContain("send_message_safe");
    expect(names).toContain("_strip_markdown");
    db.close();
  });

  it("identifier sub-word matches param name in signature", () => {
    // Prose says "fetch failed", code has `fetch_planned_events(...)`.
    const db = buildDb({
      files: [{ path: "src/loader.py" }],
      symbols: [
        {
          file: "src/loader.py",
          name: "fetch_planned_events",
          signature: "def fetch_planned_events(athlete_id, oldest, newest)",
        },
        {
          file: "src/loader.py",
          name: "noise",
          signature: "def noise(x)",
        },
      ],
    });
    const matches = matchTokensAgainstKg(
      db,
      tokenizeFailure("fetch failed for athlete events"),
    );
    expect(matches.find((m) => m.symbolName === "fetch_planned_events")).toBeDefined();
    db.close();
  });

  it("exact name match still outranks substring match for the same symbol pair", () => {
    // Symbol `marathon` should outrank `is_marathon` when prose says
    // "marathon" — exact match weight (3.0) > substring (1.0).
    const db = buildDb({
      files: [{ path: "src/race.py" }],
      symbols: [
        { file: "src/race.py", name: "marathon" },
        { file: "src/race.py", name: "is_marathon" },
      ],
    });
    const matches = matchTokensAgainstKg(db, tokenizeFailure("marathon"));
    expect(matches[0]?.symbolName).toBe("marathon");
    db.close();
  });

  it("substring match doesn't fire on names shorter than 5 chars", () => {
    // `get` (length 3) shouldn't match every symbol with `get` substring.
    const db = buildDb({
      files: [{ path: "src/x.py" }],
      symbols: [
        { file: "src/x.py", name: "get" },
        { file: "src/x.py", name: "fget" },     // 4-char name → skipped by length>=5 guard
        { file: "src/x.py", name: "getter" },   // 6-char → eligible if substring fires
      ],
    });
    const matches = matchTokensAgainstKg(db, tokenizeFailure("get the value"));
    // `get` lands via exact name match.
    expect(matches.find((m) => m.symbolName === "get")).toBeDefined();
    // `getter` would land via substring — but only if "get" sub-word is >=4 chars.
    // splitCompound("get") returns []; "the" is a stopword; "value" is len 5
    // and won't substring-match. So `getter` should NOT show up.
    expect(matches.find((m) => m.symbolName === "getter")).toBeUndefined();
    db.close();
  });
});
