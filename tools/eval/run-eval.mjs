#!/usr/bin/env node
// tools/eval/run-eval.mjs
//
// Phase 1 eval gate for the v0.5 plan (docs/v0.5-plan.md).
//
// Runs `cgrca rca` against a labeled bug corpus and measures top-1 / top-5 /
// MRR per mode. The kill criterion: text-mode top-1 must be >=2x current
// cgrca top-1 on this set, otherwise Phase 1 fails and we stop.
//
// Modes (--modes current,text,file[,baseline-grep]):
//   current      Send the failure description as-is. Pre-Phase-1, this returns
//                ~0 candidates on prose. Post-Phase-1, dispatch should detect
//                free text and route to the new text-mode automatically. We
//                still measure the "raw input" path.
//   text         Same input. There is NO new flag in Phase 1 — text-mode is
//                the new default fallback when the input doesn't match
//                symbol:/file:/test:/stack-trace shapes. We pass the same
//                description; if Phase 1 has shipped, current and text will
//                produce identical numbers (which is fine, the comparison is
//                cgrca-of-today vs. cgrca-of-yesterday).
//                If you want them differentiated *before* Phase 1 ships set
//                CGRCA_TEXT_FLAG (e.g. --experimental-text) and we'll append
//                it to the text-mode invocation.
//   file         For entries that ship `fix_files[]`, also run
//                `cgrca rca file:<first-fix-file>`. Measures how good the
//                fixed file: query is at re-ranking the right symbol within a
//                known file (the "we already know the file, can cgrca pick
//                the symbol?" upper bound).
//   baseline-grep  Naive baseline: tokenize the description, grep -rln each
//                token across the repo's source tree, rank files by
//                hit-count. This is the bar cgrca needs to beat. No cgrca
//                involvement.
//
// No npm deps. Node + cgrca CLI subprocess + git/grep.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, basename, sep, posix, isAbsolute } from 'node:path';

// ---------------------------------------------------------------------------
// CLI parse
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const out = { flags: {}, positional: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith('--')) {
				out.flags[key] = next;
				i++;
			} else {
				out.flags[key] = true;
			}
		} else {
			out.positional.push(a);
		}
	}
	return out;
}

function USAGE() {
	return `Usage:
  node tools/eval/run-eval.mjs --corpus <path> --repo <path>
                               [--modes current,text,file,baseline-grep]
                               [--cgrca <bin>] [--timeout <ms>]
                               [--top-n <n>] [--json]
                               [--out <path>] [--limit <n>]

Required:
  --corpus <path>   Path to labeled bug corpus (jsonl). See README for schema.
  --repo <path>     Repo root the corpus was labeled against.

Optional:
  --modes <list>    Comma-separated subset of: current,text,file,baseline-grep
                    Default: current,text,file
  --cgrca <bin>     Path/name of the cgrca binary. Default: 'cgrca' (PATH).
  --timeout <ms>    Per-invocation cap. Default: 30000.
  --top-n <n>       How many candidates to ask cgrca for. Default: 10.
  --json            Also emit machine-readable results to stdout.
  --out <path>      Write per-entry results JSON to this path.
                    Default: tools/eval/eval-results-<ts>.json
  --limit <n>       Only run the first N corpus entries (smoke test).

Env:
  CGRCA_TEXT_FLAG   Extra flag appended only to the 'text' mode invocation
                    (e.g. '--experimental-text'). Empty by default.
`;
}

const args = parseArgs(process.argv.slice(2));

if (args.flags.help || args.flags.h) {
	process.stdout.write(USAGE());
	process.exit(0);
}

const CORPUS = args.flags.corpus;
const REPO = args.flags.repo;
if (!CORPUS || !REPO) {
	process.stderr.write(USAGE());
	process.exit(2);
}

const REPO_ABS = resolve(REPO);
const CORPUS_ABS = resolve(CORPUS);
if (!existsSync(CORPUS_ABS)) {
	process.stderr.write(`run-eval: corpus not found: ${CORPUS_ABS}\n`);
	process.exit(2);
}
if (!existsSync(REPO_ABS) || !statSync(REPO_ABS).isDirectory()) {
	process.stderr.write(`run-eval: repo not a directory: ${REPO_ABS}\n`);
	process.exit(2);
}

const MODES = String(args.flags.modes ?? 'current,text,file')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

const KNOWN_MODES = new Set(['current', 'text', 'file', 'baseline-grep', 'llm']);
for (const m of MODES) {
	if (!KNOWN_MODES.has(m)) {
		process.stderr.write(`run-eval: unknown mode '${m}'. Known: ${[...KNOWN_MODES].join(',')}\n`);
		process.exit(2);
	}
}

const CGRCA_BIN = args.flags.cgrca ?? 'cgrca';
const TIMEOUT_MS = Number(args.flags.timeout ?? 30000);
const TOP_N = Number(args.flags['top-n'] ?? 10);
const LIMIT = args.flags.limit !== undefined ? Number(args.flags.limit) : Infinity;
const TEXT_FLAG = process.env.CGRCA_TEXT_FLAG ?? '';
const LLM_PROVIDER = process.env.CGRCA_LLM_PROVIDER ?? 'anthropic';
const LLM_MODEL = process.env.CGRCA_LLM_MODEL ?? '';

const OUT_PATH = args.flags.out
	? resolve(args.flags.out)
	: resolve(
			'tools/eval',
			`eval-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
		);

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

function warn(entry, msg) {
	const id = entry?.id ?? `line ${entry?._line ?? '?'}`;
	process.stderr.write(`run-eval: WARN [${id}] ${msg}\n`);
}

function loadCorpus(path) {
	const text = readFileSync(path, 'utf8');
	const entries = [];
	let lineNo = 0;
	for (const raw of text.split('\n')) {
		lineNo++;
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith('#') || line.startsWith('//')) continue;
		try {
			entries.push({ ...JSON.parse(line), _line: lineNo });
		} catch (err) {
			process.stderr.write(`run-eval: corpus line ${lineNo}: bad json (${err.message}); skipping\n`);
		}
	}
	return entries;
}

function validEntry(entry) {
	if (typeof entry.failure_description !== 'string' || !entry.failure_description.trim()) {
		warn(entry, 'missing/empty failure_description');
		return false;
	}
	const fixFiles = Array.isArray(entry.fix_files) ? entry.fix_files : [];
	const fixSyms = Array.isArray(entry.fix_symbols) ? entry.fix_symbols : [];
	if (fixFiles.length === 0 && fixSyms.length === 0) {
		warn(entry, 'has neither fix_files nor fix_symbols; nothing to score against');
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// cgrca subprocess
// ---------------------------------------------------------------------------

function runCgrca(failureArg, { extraFlags = [] } = {}) {
	const cliArgs = [
		'rca',
		failureArg,
		'--repo',
		REPO_ABS,
		'--json',
		'--top-n',
		String(TOP_N),
		...extraFlags,
	];
	const t0 = Date.now();
	const res = spawnSync(CGRCA_BIN, cliArgs, {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		timeout: TIMEOUT_MS,
	});
	const ms = Date.now() - t0;
	if (res.error) {
		return { ok: false, ms, err: `${res.error.code ?? ''} ${res.error.message}`.trim() };
	}
	if (res.status !== 0) {
		return {
			ok: false,
			ms,
			err: `exit ${res.status}: ${(res.stderr || '').slice(0, 500)}`,
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(res.stdout);
	} catch (err) {
		return { ok: false, ms, err: `json parse: ${err.message}` };
	}
	const candidates = Array.isArray(parsed.causalCandidates) ? parsed.causalCandidates : [];
	const llm = parsed.llm ?? null;
	return { ok: true, ms, candidates, llm };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function normalizeFile(p) {
	if (!p) return '';
	let s = String(p).split(sep).join(posix.sep);
	if (isAbsolute(s)) {
		const repoPosix = REPO_ABS.split(sep).join(posix.sep);
		if (s.startsWith(repoPosix + '/')) s = s.slice(repoPosix.length + 1);
	}
	if (s.startsWith('./')) s = s.slice(2);
	return s;
}

function fileMatches(candidateFile, fixFile) {
	const a = normalizeFile(candidateFile);
	const b = normalizeFile(fixFile);
	if (!a || !b) return false;
	if (a === b) return true;
	// Defensive substring match (handle abs vs. rel mismatch the spec calls out).
	if (a.endsWith('/' + b) || b.endsWith('/' + a)) return true;
	if (basename(a) === basename(b) && (a.endsWith(b) || b.endsWith(a))) return true;
	return false;
}

function symbolMatches(candidateName, fixSymbol) {
	if (!candidateName || !fixSymbol) return false;
	if (candidateName === fixSymbol) return true;
	// Allow Class.method == method or Class#method dotted forms.
	const tail = (s) => String(s).split(/[.#:]/).pop();
	return tail(candidateName) === tail(fixSymbol);
}

function candidateHits(candidate, entry) {
	const fixFiles = entry.fix_files ?? [];
	const fixSyms = entry.fix_symbols ?? [];
	for (const f of fixFiles) if (fileMatches(candidate.file, f)) return true;
	for (const s of fixSyms) if (symbolMatches(candidate.name, s)) return true;
	return false;
}

function scoreCandidates(candidates, entry) {
	const top = candidates.slice(0, Math.max(TOP_N, 10));
	let rank = 0;
	for (let i = 0; i < top.length; i++) {
		if (candidateHits(top[i], entry)) {
			rank = i + 1;
			break;
		}
	}
	return {
		top1: rank === 1 ? 1 : 0,
		top5: rank >= 1 && rank <= 5 ? 1 : 0,
		mrr: rank > 0 && rank <= 10 ? 1 / rank : 0,
		rank, // 0 = miss
		nCandidates: candidates.length,
	};
}

// ---------------------------------------------------------------------------
// Baseline grep
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'do', 'does',
	'doesnt', 'doing', 'for', 'from', 'has', 'have', 'how', 'i', 'in', 'is',
	'isnt', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'should',
	'so', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
	'these', 'they', 'this', 'to', 'was', 'wasnt', 'we', 'were', 'what', 'when',
	'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you',
	'your', 'bug', 'fail', 'fails', 'failed', 'failure', 'error', 'crash',
	'broken', 'wrong',
]);

function tokenize(desc) {
	const tokens = new Set();
	for (const m of desc.matchAll(/"([^"]+)"|'([^']+)'/g)) {
		const v = (m[1] ?? m[2] ?? '').trim();
		if (v) tokens.add(v);
	}
	for (const m of desc.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
		const t = m[0];
		if (STOPWORDS.has(t.toLowerCase())) continue;
		tokens.add(t);
	}
	return [...tokens];
}

function grepFiles(token, repoAbs) {
	const r = spawnSync(
		'grep',
		[
			'-rIlF',
			'--include=*.ts',
			'--include=*.tsx',
			'--include=*.js',
			'--include=*.mjs',
			'--include=*.cjs',
			'--include=*.py',
			'--include=*.go',
			'--include=*.rs',
			'--include=*.java',
			'--include=*.kt',
			'--include=*.swift',
			'--exclude-dir=node_modules',
			'--exclude-dir=dist',
			'--exclude-dir=build',
			'--exclude-dir=.git',
			'--exclude-dir=__pycache__',
			'--exclude-dir=.venv',
			'--exclude-dir=venv',
			token,
			'.',
		],
		{ cwd: repoAbs, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: TIMEOUT_MS },
	);
	if (r.status !== 0 && r.status !== 1) return [];
	return (r.stdout || '')
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => (s.startsWith('./') ? s.slice(2) : s));
}

function runBaselineGrep(entry) {
	const tokens = tokenize(entry.failure_description);
	if (tokens.length === 0) return { ok: true, ms: 0, candidates: [] };
	const t0 = Date.now();
	const fileScores = new Map();
	for (const tok of tokens) {
		const files = grepFiles(tok, REPO_ABS);
		for (const f of files) fileScores.set(f, (fileScores.get(f) ?? 0) + 1);
	}
	const ranked = [...fileScores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, Math.max(TOP_N, 10))
		.map(([file, hits]) => ({ name: basename(file), file, line: null, hits }));
	return { ok: true, ms: Date.now() - t0, candidates: ranked };
}

// ---------------------------------------------------------------------------
// Orchestrate
// ---------------------------------------------------------------------------

function runMode(mode, entry) {
	if (mode === 'current') {
		// Post-Phase-1 the binary's default for free-text is the new path; to A/B
		// the OLD bare-as-symbol behavior on the same binary, force --legacy-parse.
		// CGRCA_CURRENT_FLAG="" disables this if you want raw default behavior.
		const cur = process.env.CGRCA_CURRENT_FLAG ?? '--legacy-parse';
		const extra = cur ? cur.split(/\s+/).filter(Boolean) : [];
		return runCgrca(entry.failure_description, { extraFlags: extra });
	}
	if (mode === 'text') {
		const extra = TEXT_FLAG ? TEXT_FLAG.split(/\s+/).filter(Boolean) : [];
		return runCgrca(entry.failure_description, { extraFlags: extra });
	}
	if (mode === 'file') {
		const f = (entry.fix_files ?? [])[0];
		if (!f) return { ok: false, ms: 0, err: 'no fix_files[0] for file mode', skip: true };
		return runCgrca(`file:${f}`);
	}
	if (mode === 'baseline-grep') {
		return runBaselineGrep(entry);
	}
	if (mode === 'llm') {
		// Run cgrca with --llm and score against the LLM's chosen rootCause.
		// The static candidates also come back; we IGNORE them for `llm` mode
		// scoring (use `text` mode separately to measure the static layer).
		const extra = ['--llm', '--provider', LLM_PROVIDER];
		if (LLM_MODEL) extra.push('--model', LLM_MODEL);
		const r = runCgrca(entry.failure_description, { extraFlags: extra });
		if (!r.ok) return r;
		// runCgrca returns parsed JSON in r.candidates from causalCandidates.
		// We need the llm.verdict field too. Re-run path: parse the raw JSON here.
		// Cheapest fix: have runCgrca attach the full parsed object so we can read llm.
		return r;
	}
	return { ok: false, ms: 0, err: `unknown mode ${mode}` };
}

function fmt(n) {
	return Number.isFinite(n) ? n.toFixed(3) : '   - ';
}

function aggregate(results) {
	const summary = {};
	for (const mode of MODES) {
		const rows = results.filter((r) => r.mode === mode && !r.skipped && !r.error);
		const n = rows.length;
		const top1 = n ? rows.reduce((s, r) => s + r.score.top1, 0) / n : NaN;
		const top5 = n ? rows.reduce((s, r) => s + r.score.top5, 0) / n : NaN;
		const mrr = n ? rows.reduce((s, r) => s + r.score.mrr, 0) / n : NaN;
		const skipped = results.filter((r) => r.mode === mode && r.skipped).length;
		const errored = results.filter((r) => r.mode === mode && r.error).length;
		const meanMs = n ? rows.reduce((s, r) => s + r.ms, 0) / n : NaN;
		summary[mode] = { n, top1, top5, mrr, skipped, errored, meanMs };
	}
	return summary;
}

function renderTable(summary) {
	const rows = [['Mode', 'Top-1', 'Top-5', 'MRR', 'n', 'skip', 'err', 'avg_ms']];
	for (const mode of MODES) {
		const s = summary[mode];
		rows.push([
			mode,
			fmt(s.top1),
			fmt(s.top5),
			fmt(s.mrr),
			String(s.n),
			String(s.skipped),
			String(s.errored),
			Number.isFinite(s.meanMs) ? String(Math.round(s.meanMs)) : '   - ',
		]);
	}
	const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
	return rows
		.map((r) => r.map((cell, c) => cell.padEnd(widths[c])).join('  '))
		.join('\n');
}

function killCriterionLine(summary) {
	const cur = summary.current?.top1;
	const txt = summary.text?.top1;
	if (!Number.isFinite(cur) || !Number.isFinite(txt)) return null;
	const ratio = cur === 0 ? (txt > 0 ? Infinity : 0) : txt / cur;
	const pass = txt >= 2 * cur && (cur > 0 || txt > 0);
	const ratioStr = ratio === Infinity ? 'inf' : ratio.toFixed(2);
	return `Phase 1 kill criterion (text >= 2x current top-1): ${pass ? 'PASS' : 'FAIL'} (ratio=${ratioStr}, current=${fmt(cur)}, text=${fmt(txt)})`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const allEntries = loadCorpus(CORPUS_ABS);
const entries = allEntries.filter(validEntry).slice(0, LIMIT);
process.stderr.write(
	`run-eval: corpus=${CORPUS_ABS}\n` +
		`run-eval: repo=${REPO_ABS}\n` +
		`run-eval: ${entries.length}/${allEntries.length} entries valid; modes=[${MODES.join(',')}]; top-n=${TOP_N}; timeout=${TIMEOUT_MS}ms\n`,
);

const perEntry = [];
let i = 0;
for (const entry of entries) {
	i++;
	const id = entry.id ?? `line${entry._line}`;
	for (const mode of MODES) {
		const t0 = Date.now();
		let res;
		try {
			res = runMode(mode, entry);
		} catch (err) {
			res = { ok: false, ms: Date.now() - t0, err: err.message };
		}
		if (res.skip) {
			perEntry.push({ id, mode, skipped: true, reason: res.err, ms: 0 });
			process.stderr.write(`  [${i}/${entries.length}] ${id} ${mode}: SKIP (${res.err})\n`);
			continue;
		}
		if (!res.ok) {
			perEntry.push({ id, mode, error: res.err, ms: res.ms });
			process.stderr.write(`  [${i}/${entries.length}] ${id} ${mode}: ERR (${res.err})\n`);
			continue;
		}
		// LLM mode scores against the verdict's rootCause as a single
		// "candidate" — the LLM either picked the right thing or it didn't.
		// rootCause=null counts as a miss (LLM honestly declined).
		const candidatesForScoring =
			mode === 'llm' && res.llm
				? (res.llm.verdict?.rootCause
					? [{ file: res.llm.verdict.rootCause.file, name: res.llm.verdict.rootCause.symbol, line: res.llm.verdict.rootCause.line }]
					: [])
				: res.candidates;
		const score = scoreCandidates(candidatesForScoring, entry);
		perEntry.push({
			id,
			mode,
			ms: res.ms,
			nCandidates: score.nCandidates,
			rank: score.rank,
			score,
			...(mode === 'llm' && res.llm ? { llmCostUsd: res.llm.cost?.usd ?? 0 } : {}),
		});
		const tail = mode === 'llm' && res.llm ? ` $${(res.llm.cost?.usd ?? 0).toFixed(4)}` : '';
		process.stderr.write(
			`  [${i}/${entries.length}] ${id} ${mode}: rank=${score.rank || 'miss'} ` +
				`(${score.nCandidates} cand, ${res.ms}ms${tail})\n`,
		);
	}
}

const summary = aggregate(perEntry);
const table = renderTable(summary);
process.stdout.write('\n' + table + '\n');
const kill = killCriterionLine(summary);
if (kill) process.stdout.write('\n' + kill + '\n');

const out = {
	createdAt: new Date().toISOString(),
	corpus: CORPUS_ABS,
	repo: REPO_ABS,
	modes: MODES,
	topN: TOP_N,
	timeoutMs: TIMEOUT_MS,
	textFlag: TEXT_FLAG || null,
	nValid: entries.length,
	nTotal: allEntries.length,
	summary,
	perEntry,
};

try {
	writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
	process.stderr.write(`run-eval: wrote ${OUT_PATH}\n`);
} catch (err) {
	process.stderr.write(`run-eval: failed to write ${OUT_PATH}: ${err.message}\n`);
}

if (args.flags.json) {
	process.stdout.write('\n' + JSON.stringify(out, null, 2) + '\n');
}
