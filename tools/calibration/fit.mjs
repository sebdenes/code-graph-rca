#!/usr/bin/env node
// tools/calibration/fit.mjs
//
// Fit per-signal multipliers for cgrca's causal scorer via logistic
// regression. Inputs: a JSONL signal dump from score.mjs (one row per
// (entry, candidate) pair, with a binary `label` = 1 iff the candidate is
// the gold fix_symbol).
//
// Model: P(gold) = sigmoid( bias + sum_i w_i * signal_i )
// Loss: binary cross-entropy. Solver: batch gradient descent, plain JS,
// fixed seed (42) for the train/holdout split.
//
// Output:
//   - learned per-signal multipliers (printed)
//   - top-1 / top-5 hit rate on the held-out 20%, computed by ranking
//     candidates within each entry by predicted probability
//   - same metrics for the legacy (all-1) weights, for comparison
//
// No npm deps.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DUMP = '/tmp/cgrca-signals.jsonl';

const SIGNAL_KEYS = [
	'recencyScore',
	'proximityScore',
	'ambiguityScore',
	'coChangeScore',
	'subsystemScore',
	'complexityScore',
	'dataflowScore',
];

// Initial weights = 1.0 across the board (i.e. raw bucket sums, the legacy
// scoring). The fit pulls them toward whatever the data wants.
const INIT_W = SIGNAL_KEYS.map(() => 1.0);

// Mulberry32 PRNG so the train/holdout split is reproducible across runs.
function mulberry32(a) {
	return function () {
		let t = (a += 0x6d2b79f5);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function loadDump(path) {
	const raw = readFileSync(path, 'utf8');
	const rows = [];
	for (const line of raw.split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			rows.push(JSON.parse(t));
		} catch {}
	}
	return rows;
}

function rowsToXY(rows) {
	const X = rows.map((r) => SIGNAL_KEYS.map((k) => r.signals?.[k] ?? 0));
	const y = rows.map((r) => r.label);
	return { X, y };
}

function sigmoid(z) {
	if (z >= 0) {
		const e = Math.exp(-z);
		return 1 / (1 + e);
	}
	const e = Math.exp(z);
	return e / (1 + e);
}

function dot(w, x) {
	let s = 0;
	for (let i = 0; i < w.length; i++) s += w[i] * x[i];
	return s;
}

// Batch gradient descent. Logistic regression with L2 reg = 0 by default.
// We initialize with INIT_W (the calibration spec asks for "current bucket
// values"). lr = 0.05, iters until |grad| < tol or 2000 steps.
function fit(X, y, opts = {}) {
	const lr = opts.lr ?? 0.05;
	const maxIter = opts.maxIter ?? 2000;
	const tol = opts.tol ?? 1e-5;
	const n = X.length;
	const dim = X[0].length;
	const w = INIT_W.slice();
	let b = 0; // bias
	for (let it = 0; it < maxIter; it++) {
		const gw = new Array(dim).fill(0);
		let gb = 0;
		let loss = 0;
		for (let i = 0; i < n; i++) {
			const z = dot(w, X[i]) + b;
			const p = sigmoid(z);
			const err = p - y[i];
			for (let j = 0; j < dim; j++) gw[j] += err * X[i][j];
			gb += err;
			// stable BCE
			const eps = 1e-12;
			loss += -(y[i] * Math.log(p + eps) + (1 - y[i]) * Math.log(1 - p + eps));
		}
		for (let j = 0; j < dim; j++) gw[j] /= n;
		gb /= n;
		let gnorm = Math.abs(gb);
		for (let j = 0; j < dim; j++) {
			w[j] -= lr * gw[j];
			gnorm += Math.abs(gw[j]);
		}
		b -= lr * gb;
		if (it % 200 === 0) {
			console.error(`  iter=${it} loss=${(loss / n).toFixed(4)} |grad|=${gnorm.toFixed(5)}`);
		}
		if (gnorm < tol) {
			console.error(`  converged at iter=${it} |grad|=${gnorm.toFixed(6)}`);
			break;
		}
	}
	return { w, b };
}

// Group rows by entry id; for each group rank by predicted score, return
// rank of the gold (label=1) candidate.
function evalRanks(rowsByEntry, weights, bias) {
	let n = 0,
		hits1 = 0,
		hits5 = 0;
	let mrrSum = 0;
	for (const [, rows] of rowsByEntry) {
		const scored = rows.map((r) => {
			const x = SIGNAL_KEYS.map((k) => r.signals?.[k] ?? 0);
			let s = bias;
			for (let i = 0; i < weights.length; i++) s += weights[i] * x[i];
			return { ...r, score: s };
		});
		scored.sort((a, b) => b.score - a.score);
		// Find gold rank.
		const goldIdx = scored.findIndex((r) => r.label === 1);
		if (goldIdx === -1) continue; // gold not in candidate set (cgrca missed)
		n++;
		const rank = goldIdx + 1;
		if (rank === 1) hits1++;
		if (rank <= 5) hits5++;
		mrrSum += 1 / rank;
	}
	return { n, hits1, hits5, mrrSum };
}

function evalRanksAllEntries(rowsByEntry, totalEntries, weights, bias) {
	const r = evalRanks(rowsByEntry, weights, bias);
	// Account for entries where the gold wasn't even in the candidate set
	// (cgrca returned a candidate list that doesn't contain fix_symbol —
	// counts as miss). Denominator should be totalEntries.
	const denom = totalEntries;
	return {
		denom,
		hits1: r.hits1,
		hits5: r.hits5,
		top1: r.hits1 / denom,
		top5: r.hits5 / denom,
		mrr: r.mrrSum / denom,
	};
}

function main() {
	const dumpArg = process.argv.indexOf('--dump');
	const dumpPath = dumpArg >= 0 ? process.argv[dumpArg + 1] : DEFAULT_DUMP;
	if (!existsSync(dumpPath)) {
		console.error(`signal dump not found: ${dumpPath}`);
		console.error('run:  node tools/calibration/score.mjs --mode unanchored --dump-signals ' + dumpPath);
		process.exit(2);
	}
	const rows = loadDump(dumpPath);
	console.error(`loaded ${rows.length} candidate rows from ${dumpPath}`);

	// Group by id. Stable train/holdout split is at the *entry* level so we
	// don't leak gold candidates across the boundary.
	const byEntry = new Map();
	for (const r of rows) {
		if (!byEntry.has(r.id)) byEntry.set(r.id, []);
		byEntry.get(r.id).push(r);
	}
	const entries = [...byEntry.keys()];
	const rng = mulberry32(42);
	entries.sort(); // stable order
	// Fisher–Yates shuffle with the seeded RNG.
	for (let i = entries.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[entries[i], entries[j]] = [entries[j], entries[i]];
	}
	const cut = Math.floor(entries.length * 0.8);
	const trainIds = new Set(entries.slice(0, cut));
	const holdoutIds = new Set(entries.slice(cut));
	console.error(`split: train=${trainIds.size} holdout=${holdoutIds.size}`);

	// Drop the anchor candidate from training (rank=1 in cgrca's output is
	// always the anchor, which by construction is never the gold in the
	// unanchored corpus). Without this filter the fit overshoots
	// proximity to a negative value just to penalize "the anchor". With
	// it, weights learn to discriminate among non-anchor candidates.
	const trainRows = rows.filter((r) => trainIds.has(r.id) && r.candidateRank > 1);
	const { X, y } = rowsToXY(trainRows);
	const positives = y.reduce((a, b) => a + b, 0);
	console.error(`train rows=${y.length} positives=${positives} (anchors filtered)`);

	console.error('\nfitting logistic regression...');
	const { w, b } = fit(X, y, { lr: 0.05, maxIter: 2000, tol: 1e-5 });

	console.log('\n=== learned weights (raw) ===');
	for (let i = 0; i < SIGNAL_KEYS.length; i++) {
		console.log(`  ${SIGNAL_KEYS[i].padEnd(18)} ${w[i].toFixed(4)}`);
	}
	console.log(`  ${'bias'.padEnd(18)} ${b.toFixed(4)}`);

	// Production multipliers: clip negative weights to 0 (monotone-positive
	// per-signal contributions are required for the rationale text in
	// causal.ts to remain coherent — every signal can only *help* a
	// candidate's score). Then renormalize to keep the same overall scale.
	const wClipped = w.map((x) => Math.max(0, x));
	console.log('\n=== production multipliers (clipped >=0) ===');
	for (let i = 0; i < SIGNAL_KEYS.length; i++) {
		console.log(`  ${SIGNAL_KEYS[i].padEnd(18)} ${wClipped[i].toFixed(4)}`);
	}

	// Eval — partition rows by entry for held-out and full set.
	const holdoutByEntry = new Map();
	for (const id of holdoutIds) holdoutByEntry.set(id, byEntry.get(id) ?? []);
	const trainByEntry = new Map();
	for (const id of trainIds) trainByEntry.set(id, byEntry.get(id) ?? []);

	const learnedTrain = evalRanksAllEntries(trainByEntry, trainIds.size, w, b);
	const learnedHold = evalRanksAllEntries(holdoutByEntry, holdoutIds.size, w, b);
	const clippedTrain = evalRanksAllEntries(trainByEntry, trainIds.size, wClipped, b);
	const clippedHold = evalRanksAllEntries(holdoutByEntry, holdoutIds.size, wClipped, b);
	const legacyW = SIGNAL_KEYS.map(() => 1.0);
	const legacyTrain = evalRanksAllEntries(trainByEntry, trainIds.size, legacyW, 0);
	const legacyHold = evalRanksAllEntries(holdoutByEntry, holdoutIds.size, legacyW, 0);

	console.log('\n=== eval (per-entry rankings) ===');
	console.log('train (n=' + trainIds.size + '):');
	console.log(`  legacy   top1=${legacyTrain.top1.toFixed(3)} top5=${legacyTrain.top5.toFixed(3)} mrr=${legacyTrain.mrr.toFixed(3)}`);
	console.log(`  learned  top1=${learnedTrain.top1.toFixed(3)} top5=${learnedTrain.top5.toFixed(3)} mrr=${learnedTrain.mrr.toFixed(3)}`);
	console.log(`  clipped  top1=${clippedTrain.top1.toFixed(3)} top5=${clippedTrain.top5.toFixed(3)} mrr=${clippedTrain.mrr.toFixed(3)}`);
	console.log('holdout (n=' + holdoutIds.size + ', seed=42):');
	console.log(`  legacy   top1=${legacyHold.top1.toFixed(3)} top5=${legacyHold.top5.toFixed(3)} mrr=${legacyHold.mrr.toFixed(3)}`);
	console.log(`  learned  top1=${learnedHold.top1.toFixed(3)} top5=${learnedHold.top5.toFixed(3)} mrr=${learnedHold.mrr.toFixed(3)}`);
	console.log(`  clipped  top1=${clippedHold.top1.toFixed(3)} top5=${clippedHold.top5.toFixed(3)} mrr=${clippedHold.mrr.toFixed(3)}`);

	// Emit a JSON sidecar so causal.ts can be patched programmatically.
	const out = {
		dim: SIGNAL_KEYS.length,
		signalKeys: SIGNAL_KEYS,
		weightsRaw: Object.fromEntries(SIGNAL_KEYS.map((k, i) => [k, w[i]])),
		weightsProduction: Object.fromEntries(SIGNAL_KEYS.map((k, i) => [k, wClipped[i]])),
		bias: b,
		train: { n: trainIds.size, ...learnedTrain },
		holdout: { n: holdoutIds.size, ...learnedHold },
		clippedTrain,
		clippedHoldout: clippedHold,
		legacy: { train: legacyTrain, holdout: legacyHold },
		evalDate: new Date().toISOString().slice(0, 10),
		seed: 42,
	};
	const outPath = join(__dirname, 'fit.out.json');
	writeFileSync(outPath, JSON.stringify(out, null, 2));
	console.error(`\nwrote ${outPath}`);
}

main();
