import { describe, it, expect } from "vitest";
import { openDb, type Db } from "../../src/graph/db.js";
import { buildCausalChain } from "../../src/rca/causal.js";
import type {
  CallerTree,
  CalleeTree,
  CausalCandidate,
  RecentChange,
} from "../../src/types.js";

/**
 * Build a tiny in-memory Db with a couple of symbols and unresolved edges.
 * The schema is loaded by openDb({}); we INSERT directly to avoid needing real source.
 */
function buildDb(spec: {
  files: Array<{ path: string; subsystem: string }>;
  symbols: Array<{ file: string; name: string }>;
  unresolvedEdgesFrom: Array<{
    file: string;
    name: string;
    targets: string[];
  }>;
}): Db {
  const db = openDb({});
  const insFile = db.prepare(
    "INSERT INTO files (path, language, subsystem, loc) VALUES (?, 'typescript', ?, 0)",
  );
  const insSym = db.prepare(
    "INSERT INTO symbols (file_id, name, kind, parent_id, start_line, end_line, signature, exported) VALUES (?, ?, 'function', NULL, 1, 10, NULL, 0)",
  );
  const insEdge = db.prepare(
    "INSERT INTO edges (from_symbol_id, to_symbol_id, to_name, kind, confidence, call_line) VALUES (?, NULL, ?, 'CALLS', 0.9, NULL)",
  );

  const fileIds = new Map<string, number>();
  for (const f of spec.files) {
    const r = insFile.run(f.path, f.subsystem);
    fileIds.set(f.path, r.lastInsertRowid as number);
  }
  const symIds = new Map<string, number>();
  for (const s of spec.symbols) {
    const fid = fileIds.get(s.file);
    if (fid === undefined) throw new Error(`unknown file ${s.file}`);
    const r = insSym.run(fid, s.name);
    symIds.set(`${s.file}:${s.name}`, r.lastInsertRowid as number);
  }
  for (const u of spec.unresolvedEdgesFrom) {
    const sid = symIds.get(`${u.file}:${u.name}`);
    if (sid === undefined) throw new Error(`unknown symbol ${u.file}:${u.name}`);
    for (const t of u.targets) insEdge.run(sid, t);
  }
  return db;
}

function rc(commit: string, daysAgo: number): RecentChange {
  return {
    commit,
    date: new Date(Date.now() - daysAgo * 86400000).toISOString(),
    author: "tester",
    subject: `commit ${commit}`,
    daysAgo,
  };
}

describe("buildCausalChain", () => {
  it("recency dominates topology — 2-hop recent caller outranks direct caller with no changes", () => {
    const db = buildDb({
      files: [{ path: "src/a.ts", subsystem: "core" }],
      symbols: [
        { file: "src/a.ts", name: "A" },
        { file: "src/a.ts", name: "B" },
        { file: "src/a.ts", name: "C" },
      ],
      unresolvedEdgesFrom: [],
    });

    const callerTree: CallerTree = {
      target: "A",
      callers: [
        {
          name: "B",
          file: "src/a.ts",
          line: 1,
          confidence: 1,
          recentChanges: [],
          callers: [
            {
              name: "C",
              file: "src/a.ts",
              line: 1,
              confidence: 1,
              recentChanges: [rc("abc1234", 3)],
              callers: [],
            },
          ],
        },
      ],
    };
    const calleeTree: CalleeTree = { source: "A", callees: [] };

    const out = buildCausalChain(
      {
        anchor: { name: "A", file: "src/a.ts", line: 1, subsystem: "core" },
        callerTree,
        calleeTree,
        db,
      },
      { topN: 5 },
    );

    const cByName = new Map<string, CausalCandidate>(out.map((c) => [c.name, c]));
    const cC = cByName.get("C");
    const cB = cByName.get("B");
    expect(cC).toBeDefined();
    expect(cB).toBeDefined();
    expect(cC!.score).toBeGreaterThan(cB!.score);
    // Sanity: C should be at or near the top.
    expect(out[0]?.name === "C" || out[1]?.name === "C").toBe(true);
    // Regression: kind/loc/subsystem must be populated for in-scope candidates.
    expect(cC!.kind).toBe("function");
    expect(cC!.loc).toBeGreaterThan(0);
    expect(cC!.subsystem).toBe("core");
    expect(cByName.get("A")!.kind).toBe("function");
    expect(cByName.get("A")!.subsystem).toBe("core");
    // Print top-N for sanity-check (will appear under `--reporter=verbose`).
    // eslint-disable-next-line no-console
    console.log(
      "test#1 top-N:",
      out.map((c) => ({ name: c.name, score: c.score, signals: c.signals })),
    );
  });

  it("co-change cluster — anchor and direct caller sharing a sha both get the bonus", () => {
    const db = buildDb({
      files: [{ path: "src/a.ts", subsystem: "core" }],
      symbols: [
        { file: "src/a.ts", name: "A" },
        { file: "src/a.ts", name: "B" },
      ],
      unresolvedEdgesFrom: [],
    });

    const sharedSha = "deadbee";
    const callerTree: CallerTree = {
      target: "A",
      callers: [
        {
          name: "B",
          file: "src/a.ts",
          line: 1,
          confidence: 1,
          recentChanges: [rc(sharedSha, 5)],
          callers: [],
        },
      ],
    };
    const calleeTree: CalleeTree = { source: "A", callees: [] };

    // The anchor carries the same sha so the cluster is anchored — required
    // by the gate that drops 2-member non-anchor clusters as megacommit noise.
    // A callee D with the same sha rounds out the cluster (3 members total),
    // which both proves the bonus propagates and exercises the path where
    // anchor membership is the cluster's reason for surviving.
    calleeTree.callees.push({
      name: "D",
      resolved: true,
      file: "src/a.ts",
      line: 1,
      confidence: 1,
      recentChanges: [rc(sharedSha, 5)],
      callees: [],
    });

    const out = buildCausalChain(
      {
        anchor: {
          name: "A",
          file: "src/a.ts",
          line: 1,
          subsystem: "core",
          recentChanges: [rc(sharedSha, 5)],
        },
        callerTree,
        calleeTree,
        db,
      },
      { topN: 5 },
    );

    const byName = new Map(out.map((c) => [c.name, c]));
    const b = byName.get("B");
    const d = byName.get("D");
    expect(b).toBeDefined();
    expect(d).toBeDefined();
    expect(b!.signals.coChangeScore).toBeGreaterThan(0);
    expect(d!.signals.coChangeScore).toBeGreaterThan(0);
    const top3 = out.slice(0, 3).map((c) => c.name);
    expect(top3).toContain("B");
    expect(top3).toContain("D");
  });

  it("ambiguity hint — direct callee with 4 unresolved outgoing CALLS ranks in top-3", () => {
    const db = buildDb({
      files: [{ path: "src/a.ts", subsystem: "core" }],
      symbols: [
        { file: "src/a.ts", name: "A" },
        { file: "src/a.ts", name: "D" },
      ],
      unresolvedEdgesFrom: [
        { file: "src/a.ts", name: "D", targets: ["x", "y", "z", "w"] },
      ],
    });

    const callerTree: CallerTree = { target: "A", callers: [] };
    const calleeTree: CalleeTree = {
      source: "A",
      callees: [
        {
          name: "D",
          resolved: true,
          file: "src/a.ts",
          line: 1,
          confidence: 1,
          recentChanges: [],
          callees: [],
        },
      ],
    };

    const out = buildCausalChain(
      {
        anchor: { name: "A", file: "src/a.ts", line: 1, subsystem: "core" },
        callerTree,
        calleeTree,
        db,
      },
      { topN: 5 },
    );

    const top3 = out.slice(0, 3);
    const d = top3.find((c) => c.name === "D");
    expect(d).toBeDefined();
    expect(d!.unresolvedCallTargets.length).toBe(4);
    expect(d!.signals.ambiguityScore).toBeGreaterThan(0);
    expect(d!.rationale.toLowerCase()).toContain("unresolved");
  });

  it("tie-break by recency — equal scores, newer daysAgo wins", () => {
    // Build two candidates that end up with identical scores via different signals.
    // Strategy: two direct callees (proximity 1 → +1 each), no ambiguity, no co-change,
    // no subsystem match. Recency drives the ordering.
    const db = buildDb({
      files: [{ path: "src/a.ts", subsystem: "core" }],
      symbols: [
        { file: "src/a.ts", name: "A" },
        { file: "src/a.ts", name: "X" },
        { file: "src/a.ts", name: "Y" },
      ],
      unresolvedEdgesFrom: [],
    });

    const callerTree: CallerTree = { target: "A", callers: [] };
    const calleeTree: CalleeTree = {
      source: "A",
      callees: [
        {
          name: "X",
          resolved: true,
          file: "src/a.ts",
          line: 1,
          confidence: 1,
          // Same recency bucket: both 3 days vs 6 days fall in <=7 → +3.
          recentChanges: [rc("sha-x", 6)],
          callees: [],
        },
        {
          name: "Y",
          resolved: true,
          file: "src/a.ts",
          line: 1,
          confidence: 1,
          recentChanges: [rc("sha-y", 3)],
          callees: [],
        },
      ],
    };

    const out = buildCausalChain(
      {
        anchor: { name: "A", file: "src/a.ts", line: 1, subsystem: "core" },
        callerTree,
        calleeTree,
        db,
      },
      { topN: 5 },
    );

    const xIdx = out.findIndex((c) => c.name === "X");
    const yIdx = out.findIndex((c) => c.name === "Y");
    expect(xIdx).toBeGreaterThanOrEqual(0);
    expect(yIdx).toBeGreaterThanOrEqual(0);
    // Same score (both proximity=1, recency=3, others 0), so Y (3 days) wins.
    const xCand = out[xIdx]!;
    const yCand = out[yIdx]!;
    expect(xCand.score).toBe(yCand.score);
    expect(yIdx).toBeLessThan(xIdx);
  });

  it("deterministic — running twice on the same input yields identical ordering", () => {
    const db = buildDb({
      files: [
        { path: "src/a.ts", subsystem: "core" },
        { path: "src/b.ts", subsystem: "core" },
      ],
      symbols: [
        { file: "src/a.ts", name: "A" },
        { file: "src/a.ts", name: "B" },
        { file: "src/b.ts", name: "C" },
        { file: "src/b.ts", name: "D" },
      ],
      unresolvedEdgesFrom: [
        { file: "src/b.ts", name: "D", targets: ["foo", "bar"] },
      ],
    });

    const callerTree: CallerTree = {
      target: "A",
      callers: [
        {
          name: "B",
          file: "src/a.ts",
          line: 1,
          confidence: 1,
          recentChanges: [rc("aaa1111", 10)],
          callers: [
            {
              name: "C",
              file: "src/b.ts",
              line: 1,
              confidence: 1,
              recentChanges: [rc("bbb2222", 40)],
              callers: [],
            },
          ],
        },
      ],
    };
    const calleeTree: CalleeTree = {
      source: "A",
      callees: [
        {
          name: "D",
          resolved: true,
          file: "src/b.ts",
          line: 1,
          confidence: 1,
          recentChanges: [],
          callees: [],
        },
      ],
    };

    const input = {
      anchor: {
        name: "A",
        file: "src/a.ts" as string | null,
        line: 1 as number | null,
        subsystem: "core" as string | null,
      },
      callerTree,
      calleeTree,
      db,
    };

    const a = buildCausalChain(input, { topN: 5 });
    const b = buildCausalChain(input, { topN: 5 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    // Determinism also holds under the legacy-weights A/B path, and the
    // two paths produce different orderings/scores (otherwise the toggle
    // would be a no-op). This guards both: the deterministic property
    // *and* that the toggle actually changes behavior.
    const aLegacy = buildCausalChain(input, { topN: 5, useLegacyWeights: true });
    const bLegacy = buildCausalChain(input, { topN: 5, useLegacyWeights: true });
    expect(JSON.stringify(aLegacy)).toBe(JSON.stringify(bLegacy));
    // The score values must differ between paths (legacy uses bucket sums,
    // calibrated applies learned multipliers). Compare aggregate scores.
    const scoresCalibrated = a.map((c) => c.score).join(",");
    const scoresLegacy = aLegacy.map((c) => c.score).join(",");
    expect(scoresCalibrated).not.toBe(scoresLegacy);
  });

  it("megacommit bystander does NOT beat the anchor (legacy weights)", () => {
    // Anchor A and a direct callee D both touched in the SAME megacommit, plus
    // ten other bystanders touched in that commit (12-member cluster). With the
    // demoted co-change weight (per-member ~ 2 / log2(13) ≈ 0.54) the bystander
    // cannot leapfrog the anchor's recency 3 + proximity 2.5 = 5.5.
    //
    // Asserted under `useLegacyWeights: true` because this test is about the
    // bucket-shape gating (megacommit demotion + proximity boost), not about
    // the calibrated multipliers — under calibrated weights proximity has
    // multiplier 0 (proximity is constant within the unanchored candidate
    // sets the calibration was fit on), so the legacy bucket assumption no
    // longer applies.
    const filesSpec: Array<{ path: string; subsystem: string }> = [
      { path: "src/a.ts", subsystem: "core" },
    ];
    const symbolsSpec: Array<{ file: string; name: string }> = [
      { file: "src/a.ts", name: "A" },
      { file: "src/a.ts", name: "D" },
    ];
    for (let i = 0; i < 10; i++) {
      symbolsSpec.push({ file: "src/a.ts", name: `bystander${i}` });
    }
    const db = buildDb({
      files: filesSpec,
      symbols: symbolsSpec,
      unresolvedEdgesFrom: [],
    });

    const mega = "megac0m";
    const callees = [
      {
        name: "D",
        resolved: true,
        file: "src/a.ts",
        line: 1,
        confidence: 1,
        recentChanges: [rc(mega, 3)],
        callees: [],
      },
    ];
    for (let i = 0; i < 10; i++) {
      callees.push({
        name: `bystander${i}`,
        resolved: true,
        file: "src/a.ts",
        line: 1,
        confidence: 1,
        recentChanges: [rc(mega, 3)],
        callees: [],
      });
    }
    const calleeTree: CalleeTree = { source: "A", callees };
    const callerTree: CallerTree = { target: "A", callers: [] };

    const out = buildCausalChain(
      {
        anchor: {
          name: "A",
          file: "src/a.ts",
          line: 1,
          subsystem: "core",
          recentChanges: [rc(mega, 3)],
        },
        callerTree,
        calleeTree,
        db,
      },
      { topN: 12, useLegacyWeights: true },
    );

    const byName = new Map(out.map((c) => [c.name, c]));
    const a = byName.get("A");
    const d = byName.get("D");
    expect(a).toBeDefined();
    expect(d).toBeDefined();
    expect(a!.score).toBeGreaterThan(d!.score);
    expect(out[0]?.name).toBe("A");
    // The demoted per-cluster contribution must be well below the old +2.
    expect(d!.signals.coChangeScore).toBeLessThan(1.0);
  });

  it("complexity bonus pushes a fat orchestrator above its tiny callee", () => {
    // Two direct callees, neither changed recently and no co-change.
    // FAT has 400 lines, TINY has 5 lines. With identical recency/proximity,
    // FAT's complexity bonus (~ log2(21) * 0.6 ≈ 1.5) beats TINY's (~0.22).
    const db = openDb({});
    const insFile = db.prepare(
      "INSERT INTO files (path, language, subsystem, loc) VALUES (?, 'typescript', ?, 0)",
    );
    const insSym = db.prepare(
      "INSERT INTO symbols (file_id, name, kind, parent_id, start_line, end_line, signature, exported) VALUES (?, ?, 'function', NULL, ?, ?, NULL, 0)",
    );
    const fid = insFile.run("src/a.ts", "core").lastInsertRowid as number;
    insSym.run(fid, "A", 1, 5);
    insSym.run(fid, "TINY", 1, 5); // loc = 5
    insSym.run(fid, "FAT", 1, 400); // loc = 400

    const callerTree: CallerTree = { target: "A", callers: [] };
    const calleeTree: CalleeTree = {
      source: "A",
      callees: [
        {
          name: "TINY",
          resolved: true,
          file: "src/a.ts",
          line: 1,
          confidence: 1,
          recentChanges: [],
          callees: [],
        },
        {
          name: "FAT",
          resolved: true,
          file: "src/a.ts",
          line: 1,
          confidence: 1,
          recentChanges: [],
          callees: [],
        },
      ],
    };

    const out = buildCausalChain(
      {
        anchor: { name: "A", file: "src/a.ts", line: 1, subsystem: "core" },
        callerTree,
        calleeTree,
        db,
      },
      { topN: 5 },
    );

    const byName = new Map(out.map((c) => [c.name, c]));
    const fat = byName.get("FAT");
    const tiny = byName.get("TINY");
    expect(fat).toBeDefined();
    expect(tiny).toBeDefined();
    expect(fat!.signals.complexityScore).toBeGreaterThan(
      tiny!.signals.complexityScore,
    );
    expect(fat!.score).toBeGreaterThan(tiny!.score);
    // FAT must outrank TINY in the listing.
    const fatIdx = out.findIndex((c) => c.name === "FAT");
    const tinyIdx = out.findIndex((c) => c.name === "TINY");
    expect(fatIdx).toBeLessThan(tinyIdx);
  });

  it("calibrated weights — score regression baseline (locks in the 2026-05-02 v2 fit)", () => {
    // Tiny fixture exercising every signal so the scored sum is sensitive
    // to all six learned multipliers. If anyone retunes the weights this
    // assertion will fail loudly — pointing them at tools/calibration/fit.mjs.
    const db = buildDb({
      files: [{ path: "src/a.ts", subsystem: "core" }],
      symbols: [
        { file: "src/a.ts", name: "A" },
        { file: "src/a.ts", name: "B" },
      ],
      unresolvedEdgesFrom: [
        { file: "src/a.ts", name: "B", targets: ["x", "y"] },
      ],
    });
    const callerTree: CallerTree = {
      target: "A",
      callers: [
        {
          name: "B",
          file: "src/a.ts",
          line: 1,
          confidence: 1,
          recentChanges: [rc("sha-b", 3)],
          callers: [],
        },
      ],
    };
    const calleeTree: CalleeTree = { source: "A", callees: [] };
    const input = {
      anchor: {
        name: "A",
        file: "src/a.ts" as string | null,
        line: 1 as number | null,
        subsystem: "core" as string | null,
      },
      callerTree,
      calleeTree,
      db,
    };
    const calibrated = buildCausalChain(input, { topN: 5 });
    const legacy = buildCausalChain(input, { topN: 5, useLegacyWeights: true });

    // Sanity: same candidate set, same ordering hint, but different scores.
    const cb = calibrated.find((c) => c.name === "B");
    const lb = legacy.find((c) => c.name === "B");
    expect(cb).toBeDefined();
    expect(lb).toBeDefined();
    // Anchor "A" subsystem = "core"; B is in src/a.ts subsystem "core" so
    // subsystemScore=0.5. B has 2 unresolved edges → ambiguityScore=1
    // (bucket_2_3). recencyScore=3 (3 days ago). proximityScore=1 (direct
    // caller). complexityScore = log2(10/20+1)*0.6 ≈ 0.351 (loc=10).
    // dataflowScore=0 (no resolved CALLS edges in fixture).
    //
    // Calibrated (v2 weights, dataflow=0): 0.1815*3 + 0*1 + 0.0820*1
    //   + 0.5108*0 + 0.7840*0.5 + 0.3136*0.351 + 0*0
    //   = 0.5445 + 0.0820 + 0.3920 + 0.1101 ≈ 1.129
    // Legacy (all 1.0): 3 + 1 + 1 + 0 + 0.5 + 0.351 + 0 = 5.851
    expect(cb!.score).toBeGreaterThan(1.05);
    expect(cb!.score).toBeLessThan(1.20);
    expect(lb!.score).toBeGreaterThan(5.5);
    expect(lb!.score).toBeLessThan(6.0);
    // Multipliers must drive a measurable gap between the two paths.
    expect(Math.abs(cb!.score - lb!.score)).toBeGreaterThan(4);
  });

  it("data-flow distance ranks an arg-source above a topology-only neighbor", () => {
    // Fixture: anchor A. Topology has TWO direct callers, X (the gold) and
    // BYS (a bystander); both at topology distance 1. We then add a CALLS
    // edge X→A (resolved) so pathBetween(X, A) returns a 2-step path —
    // dataflowScore for X is 1.5. BYS has no resolved outgoing call to A,
    // so its dataflowScore is 0. With dataflow weight 1.0 the gap should be
    // enough to break the topology tie and put X above BYS.
    const db = openDb({});
    const insFile = db.prepare(
      "INSERT INTO files (path, language, subsystem, loc) VALUES (?, 'typescript', ?, 0)",
    );
    const insSym = db.prepare(
      "INSERT INTO symbols (file_id, name, kind, parent_id, start_line, end_line, signature, exported) VALUES (?, ?, 'function', NULL, 1, 10, NULL, 0)",
    );
    const fid = insFile.run("src/a.ts", "core").lastInsertRowid as number;
    const aId = insSym.run(fid, "A").lastInsertRowid as number;
    const xId = insSym.run(fid, "X").lastInsertRowid as number;
    insSym.run(fid, "BYS").lastInsertRowid as number;
    // Resolved CALLS edge X→A so pathBetween(X, A) is a real 2-step path.
    db.prepare(
      "INSERT INTO edges (from_symbol_id, to_symbol_id, to_name, kind, confidence, call_line) VALUES (?, ?, 'A', 'CALLS', 1.0, NULL)",
    ).run(xId, aId);

    const callerTree: CallerTree = {
      target: "A",
      callers: [
        {
          name: "X",
          file: "src/a.ts",
          line: 1,
          confidence: 1,
          recentChanges: [],
          callers: [],
        },
        {
          name: "BYS",
          file: "src/a.ts",
          line: 1,
          confidence: 1,
          recentChanges: [],
          callers: [],
        },
      ],
    };
    const calleeTree: CalleeTree = { source: "A", callees: [] };

    const out = buildCausalChain(
      {
        anchor: { name: "A", file: "src/a.ts", line: 1, subsystem: "core" },
        callerTree,
        calleeTree,
        db,
      },
      // Use legacy weights to avoid proximity's calibrated weight-0 collapse:
      // both candidates are direct callers (proximity=1) so under calibrated
      // weights they tie on every signal except dataflow — the test still
      // works, but legacy makes the *intent* clearer (without dataflow they
      // would tie exactly; with dataflow X wins).
      { topN: 5, useLegacyWeights: true },
    );

    const byName = new Map(out.map((c) => [c.name, c]));
    const x = byName.get("X");
    const bys = byName.get("BYS");
    expect(x).toBeDefined();
    expect(bys).toBeDefined();
    expect(x!.signals.dataflowScore).toBeGreaterThan(0);
    expect(bys!.signals.dataflowScore).toBe(0);
    expect(x!.score).toBeGreaterThan(bys!.score);
    const xIdx = out.findIndex((c) => c.name === "X");
    const bysIdx = out.findIndex((c) => c.name === "BYS");
    expect(xIdx).toBeLessThan(bysIdx);
    // Rationale should call out the data-flow hops when dominant.
    if (x!.signals.dataflowScore >= x!.signals.proximityScore) {
      expect(x!.rationale.toLowerCase()).toContain("data-flow");
    }
  });
});
