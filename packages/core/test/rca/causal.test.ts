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

  it("calibrated weights — score regression baseline (locks in the 2026-05-02 v3 fit)", () => {
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
    // Calibrated (v3 weights, dataflow=0): 0.0766*3 + 0*1 + 0.2133*1
    //   + 0.4744*0 + 0.8909*0.5 + 0.1679*0.351 + 0*0
    //   = 0.2298 + 0.2133 + 0.4455 + 0.0589 ≈ 0.947
    // Legacy (all 1.0): 3 + 1 + 1 + 0 + 0.5 + 0.351 + 0 = 5.851
    expect(cb!.score).toBeGreaterThan(0.88);
    expect(cb!.score).toBeLessThan(1.00);
    expect(lb!.score).toBeGreaterThan(5.5);
    expect(lb!.score).toBeLessThan(6.0);
    // Multipliers must drive a measurable gap between the two paths.
    expect(Math.abs(cb!.score - lb!.score)).toBeGreaterThan(4);
  });

  it("data-flow distance ranks an arg-source above a topology-only neighbor", () => {
    // Fixture: anchor A. Topology has TWO direct callers, X (the gold) and
    // BYS (a bystander); both at topology distance 1. To exercise the
    // week-7 arg-binding gate we model X as a *producer* whose value flows
    // into the argument of a call from MID→A (so pathBetween(X, A) traces
    // X --ARG_BIND--> MID --CALLS--> A, one ARG_BIND hop = dataflowScore
    // 0.75). BYS has no arg-binding flow to A, so its dataflowScore stays 0.
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
    const midId = insSym.run(fid, "MID").lastInsertRowid as number;
    // Resolved CALLS edge MID→A so the second leg of the path exists.
    const edgeRes = db.prepare(
      "INSERT INTO edges (from_symbol_id, to_symbol_id, to_name, kind, confidence, call_line) VALUES (?, ?, 'A', 'CALLS', 1.0, NULL)",
    ).run(midId, aId);
    const edgeId = edgeRes.lastInsertRowid as number;
    // Arg binding: X (the producer) flows into the call MID→A as an
    // identifier argument. pathBetween will hop X→MID via ARG_BIND.
    db.prepare(
      "INSERT INTO arg_bindings (edge_id, position, source_kind, source_text, source_symbol_id) VALUES (?, 0, 'identifier', 'X', ?)",
    ).run(edgeId, xId);

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
    // Rationale should call out the arg-binding hops when dominant.
    if (x!.signals.dataflowScore >= x!.signals.proximityScore) {
      expect(x!.rationale.toLowerCase()).toContain("arg-binding");
    }
  });

  it("dataflowScore is 0 for pure-CALLS paths (week-7 gate)", () => {
    // X→A is a resolved CALLS edge with NO arg_bindings table row. Under
    // the week-7 redesign, pathBetween still finds X→A but every hop
    // is CALLS, so dataflowScore must be 0 (proximityScore already
    // captures the topology — re-counting it here was the v6 noise).
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
      { topN: 5, useLegacyWeights: true },
    );

    const x = out.find((c) => c.name === "X");
    expect(x).toBeDefined();
    expect(x!.signals.dataflowScore).toBe(0);
  });

  it("dataflowScore is non-zero for paths through arg_bindings (week-7 gate)", () => {
    // X is a producer flowing into the MID→A call as an identifier arg.
    // pathBetween(X, A) crosses one ARG_BIND edge then one CALLS edge —
    // argBindHops=1 → dataflowScore = DATAFLOW_PER_ARG_HOP = 0.75.
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
    const midId = insSym.run(fid, "MID").lastInsertRowid as number;
    const edgeRes = db.prepare(
      "INSERT INTO edges (from_symbol_id, to_symbol_id, to_name, kind, confidence, call_line) VALUES (?, ?, 'A', 'CALLS', 1.0, NULL)",
    ).run(midId, aId);
    const edgeId = edgeRes.lastInsertRowid as number;
    db.prepare(
      "INSERT INTO arg_bindings (edge_id, position, source_kind, source_text, source_symbol_id) VALUES (?, 0, 'identifier', 'X', ?)",
    ).run(edgeId, xId);

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
      { topN: 5, useLegacyWeights: true },
    );

    const x = out.find((c) => c.name === "X");
    expect(x).toBeDefined();
    expect(x!.signals.dataflowScore).toBeGreaterThan(0);
    // One arg-binding hop → exactly DATAFLOW_PER_ARG_HOP (0.75).
    expect(x!.signals.dataflowScore).toBeCloseTo(0.75, 5);
  });

  it("dataflowScore scales with number of arg-bind hops (week-7 gate)", () => {
    // Build two chains of equal topology length but different ARG_BIND
    // density:
    //   ONE: X1 --ARG_BIND--> MID1 --CALLS--> A     (1 arg-bind hop)
    //   TWO: X2 --ARG_BIND--> MID2 --ARG_BIND--> A  (2 arg-bind hops)
    // Expect dataflowScore(X2) > dataflowScore(X1).
    const db = openDb({});
    const insFile = db.prepare(
      "INSERT INTO files (path, language, subsystem, loc) VALUES (?, 'typescript', ?, 0)",
    );
    const insSym = db.prepare(
      "INSERT INTO symbols (file_id, name, kind, parent_id, start_line, end_line, signature, exported) VALUES (?, ?, 'function', NULL, 1, 10, NULL, 0)",
    );
    const fid = insFile.run("src/a.ts", "core").lastInsertRowid as number;
    const aId = insSym.run(fid, "A").lastInsertRowid as number;

    // Chain ONE: 1 arg-bind hop.
    const x1 = insSym.run(fid, "X1").lastInsertRowid as number;
    const mid1 = insSym.run(fid, "MID1").lastInsertRowid as number;
    const e1 = db.prepare(
      "INSERT INTO edges (from_symbol_id, to_symbol_id, to_name, kind, confidence, call_line) VALUES (?, ?, 'A', 'CALLS', 1.0, NULL)",
    ).run(mid1, aId).lastInsertRowid as number;
    db.prepare(
      "INSERT INTO arg_bindings (edge_id, position, source_kind, source_text, source_symbol_id) VALUES (?, 0, 'identifier', 'X1', ?)",
    ).run(e1, x1);

    // Chain TWO: 2 arg-bind hops. X2 flows into MID2's call to FINAL2,
    // and MID2 flows into FINAL2's call to A. pathBetween from X2:
    //   X2 -ARG_BIND-> MID2 -ARG_BIND-> FINAL2  ... but we want it to land at A.
    // Easier model: X2 flows into MID2 (via call MID2→FINAL2) and MID2
    // flows into A (via call A→<sink>). Then pathBetween(X2, A): X2 hops
    // ARG_BIND to MID2, MID2 hops ARG_BIND to A. Two ARG_BIND hops, no CALLS.
    const x2 = insSym.run(fid, "X2").lastInsertRowid as number;
    const mid2 = insSym.run(fid, "MID2").lastInsertRowid as number;
    const final2 = insSym.run(fid, "FINAL2").lastInsertRowid as number;
    // Call MID2→FINAL2 with arg X2 (so X2 -ARG_BIND-> MID2).
    const e2 = db.prepare(
      "INSERT INTO edges (from_symbol_id, to_symbol_id, to_name, kind, confidence, call_line) VALUES (?, ?, 'FINAL2', 'CALLS', 1.0, NULL)",
    ).run(mid2, final2).lastInsertRowid as number;
    db.prepare(
      "INSERT INTO arg_bindings (edge_id, position, source_kind, source_text, source_symbol_id) VALUES (?, 0, 'identifier', 'X2', ?)",
    ).run(e2, x2);
    // Call A→<sink> with arg MID2 (so MID2 -ARG_BIND-> A).
    const sink = insSym.run(fid, "SINK").lastInsertRowid as number;
    const e3 = db.prepare(
      "INSERT INTO edges (from_symbol_id, to_symbol_id, to_name, kind, confidence, call_line) VALUES (?, ?, 'SINK', 'CALLS', 1.0, NULL)",
    ).run(aId, sink).lastInsertRowid as number;
    db.prepare(
      "INSERT INTO arg_bindings (edge_id, position, source_kind, source_text, source_symbol_id) VALUES (?, 0, 'identifier', 'MID2', ?)",
    ).run(e3, mid2);

    const callerTree: CallerTree = {
      target: "A",
      callers: [
        { name: "X1", file: "src/a.ts", line: 1, confidence: 1, recentChanges: [], callers: [] },
        { name: "X2", file: "src/a.ts", line: 1, confidence: 1, recentChanges: [], callers: [] },
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
      { topN: 10, useLegacyWeights: true },
    );

    const cx1 = out.find((c) => c.name === "X1");
    const cx2 = out.find((c) => c.name === "X2");
    expect(cx1).toBeDefined();
    expect(cx2).toBeDefined();
    expect(cx1!.signals.dataflowScore).toBeGreaterThan(0);
    expect(cx2!.signals.dataflowScore).toBeGreaterThan(
      cx1!.signals.dataflowScore,
    );
  });
});
