#!/usr/bin/env node
// tools/calibration/score.mjs
//
// Run every entry in corpus.jsonl through `cgrca rca` against its
// parent_commit and report the baseline metrics:
//
//   - Top-1 hit rate
//   - Top-5 hit rate
//   - MRR (within top 10)
//   - Per-signal Pearson correlation between the signal score on the
//     fix_symbol candidate and the binary hit outcome
//
// Strategy: for each (repo, parent_commit) pair we materialise a git
// worktree at /tmp/cgrca-cal-<short-sha>, run cgrca there, and tear it
// down at the end. Worktrees are cheap (no full clone) and let us run
// concurrent invocations safely.
//
// No npm deps — Node + git + cgrca CLI only.

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, 'corpus.jsonl');
const CGRCA_CLI = join(__dirname, '..', '..', 'packages', 'core', 'dist', 'cli.js');

const REPO_PATHS = {
	'sebdenes/code-graph-rca': '/Users/I048171/code-graph-rca',
	'sebdenes/athlai': '/Users/I048171/Athlai-Antigravity/athlai',
};

const TOP_K_FOR_MRR = 10;

function sh(cmd, opts = {}) {
	return execSync(cmd, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...opts });
}
function shTry(cmd, opts = {}) {
	try {
		return sh(cmd, opts);
	} catch {
		return null;
	}
}

function loadEntries() {
	const raw = readFileSync(CORPUS_PATH, 'utf8');
	const entries = [];
	for (const line of raw.split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			const obj = JSON.parse(t);
			if (obj.error) continue; // skip documented failures
			if (!obj.fix_symbol || !obj.parent_commit || !obj.repo) continue;
			entries.push(obj);
		} catch {}
	}
	return entries;
}

function setupWorktree(repoPath, parentSha) {
	const wt = mkdtempSync(join(tmpdir(), `cgrca-cal-${parentSha.slice(0, 8)}-`));
	const result = shTry(`git -C ${repoPath} worktree add --detach ${wt} ${parentSha}`);
	if (!result && !existsSync(join(wt, '.git'))) {
		// worktree add can print to stderr and still succeed; double-check.
		try {
			rmSync(wt, { recursive: true, force: true });
		} catch {}
		return null;
	}
	return wt;
}

function teardownWorktree(repoPath, wt) {
	shTry(`git -C ${repoPath} worktree remove --force ${wt}`);
	try {
		rmSync(wt, { recursive: true, force: true });
	} catch {}
}

function runCgrca(worktree, cgrcaInput) {
	// 60s timeout per call.
	const out = shTry(
		`node ${CGRCA_CLI} rca ${JSON.stringify(cgrcaInput)} --json --repo ${JSON.stringify(worktree)}`,
		{ timeout: 60_000 },
	);
	if (!out) return null;
	try {
		return JSON.parse(out);
	} catch {
		return null;
	}
}

function findRank(candidates, fixSymbol, fixSymbolFile) {
	if (!candidates || candidates.length === 0) return -1;
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		if (c.name === fixSymbol) {
			// If we have a file, prefer file match too — but tolerate file misses.
			if (!fixSymbolFile || c.file === fixSymbolFile) return i + 1;
		}
	}
	// Fallback: name-only match anywhere.
	for (let i = 0; i < candidates.length; i++) {
		if (candidates[i].name === fixSymbol) return i + 1;
	}
	return -1;
}

function pearson(xs, ys) {
	const n = Math.min(xs.length, ys.length);
	if (n < 2) return NaN;
	let sx = 0,
		sy = 0;
	for (let i = 0; i < n; i++) {
		sx += xs[i];
		sy += ys[i];
	}
	const mx = sx / n,
		my = sy / n;
	let num = 0,
		dx = 0,
		dy = 0;
	for (let i = 0; i < n; i++) {
		const a = xs[i] - mx;
		const b = ys[i] - my;
		num += a * b;
		dx += a * a;
		dy += b * b;
	}
	if (dx === 0 || dy === 0) return NaN;
	return num / Math.sqrt(dx * dy);
}

function main() {
	const entries = loadEntries();
	console.error(`scoring ${entries.length} entries...`);

	const results = [];
	const SIGNAL_KEYS = [
		'recencyScore',
		'proximityScore',
		'ambiguityScore',
		'coChangeScore',
		'subsystemScore',
		'complexityScore',
	];
	const signalSeries = Object.fromEntries(SIGNAL_KEYS.map((k) => [k, []]));
	const hitSeries = [];

	let processed = 0;
	let hits1 = 0,
		hits5 = 0;
	let mrrSum = 0;

	for (const e of entries) {
		processed++;
		const repoPath = REPO_PATHS[e.repo];
		if (!repoPath) {
			console.error(`[skip] ${e.id} unknown repo`);
			continue;
		}
		const wt = setupWorktree(repoPath, e.parent_commit);
		if (!wt) {
			console.error(`[skip] ${e.id} worktree-add failed`);
			continue;
		}

		try {
			const result = runCgrca(wt, e.cgrca_input);
			if (!result) {
				console.error(`[skip] ${e.id} cgrca failed/timeout`);
				continue;
			}
			const cands = result.causalCandidates || [];
			const rank = findRank(cands, e.fix_symbol, e.fix_symbol_file);
			const hit1 = rank === 1 ? 1 : 0;
			const hit5 = rank >= 1 && rank <= 5 ? 1 : 0;
			const reciprocal = rank >= 1 && rank <= TOP_K_FOR_MRR ? 1 / rank : 0;

			hits1 += hit1;
			hits5 += hit5;
			mrrSum += reciprocal;

			// Per-signal series — read signals on the fix_symbol candidate
			// (or zeros if not present in the candidate set).
			let signals = null;
			if (rank > 0) signals = cands[rank - 1].signals || null;
			for (const k of SIGNAL_KEYS) {
				signalSeries[k].push(signals?.[k] ?? 0);
			}
			hitSeries.push(hit1);

			results.push({ id: e.id, rank, hit1, hit5, score: rank > 0 ? cands[rank - 1].score : 0 });
			console.error(
				`[${processed}/${entries.length}] ${e.id} rank=${rank === -1 ? 'miss' : rank}`,
			);
		} finally {
			teardownWorktree(repoPath, wt);
		}
	}

	const n = hitSeries.length;
	console.log('\n=== cgrca calibration baseline ===');
	console.log(`scored: ${n} / ${entries.length} entries`);
	if (n === 0) {
		console.log('no successful runs — nothing to summarise');
		return;
	}
	console.log(`Top-1 hit rate:  ${(hits1 / n).toFixed(3)}  (${hits1}/${n})`);
	console.log(`Top-5 hit rate:  ${(hits5 / n).toFixed(3)}  (${hits5}/${n})`);
	console.log(`MRR (top ${TOP_K_FOR_MRR}):    ${(mrrSum / n).toFixed(3)}`);

	console.log('\nPer-signal Pearson correlation with hit (top-1):');
	for (const k of SIGNAL_KEYS) {
		const r = pearson(signalSeries[k], hitSeries);
		console.log(`  ${k.padEnd(18)} r=${Number.isNaN(r) ? '  n/a' : r.toFixed(3)}`);
	}

	// Histogram of ranks.
	const buckets = { '1': 0, '2-5': 0, '6-10': 0, miss: 0 };
	for (const r of results) {
		if (r.rank === 1) buckets['1']++;
		else if (r.rank >= 2 && r.rank <= 5) buckets['2-5']++;
		else if (r.rank >= 6 && r.rank <= 10) buckets['6-10']++;
		else buckets.miss++;
	}
	console.log('\nRank distribution:');
	for (const [k, v] of Object.entries(buckets)) {
		console.log(`  rank ${k.padEnd(5)} ${v}`);
	}
}

main();
