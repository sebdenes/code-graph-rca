#!/usr/bin/env node
// tools/eval/llm-codebase-enriched-baseline.mjs
//
// v0.6 Phase 6 gate baseline: BM25-over-content retrieval (same as
// llm-codebase-baseline.mjs) PLUS cgrca structural enrichment per
// candidate. The LLM sees: failure description + retrieved files'
// body snippets + callers/callees/recent-commits-per-file from cgrca.
//
// Hypothesis: cgrca's structural facts (graph + git) tip the LLM's
// pick on bugs where embedding similarity alone leaves it ambiguous.
// Phase 6 kill criterion (per docs/v0.6-plan.md): must lift top-1 by
// ≥5pp vs `llm-codebase` alone on the 9-bug corpus.
//
// Same auth + zero-deps story as llm-codebase-baseline.mjs.

import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, relative, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const out = { flags: {} };
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
		}
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const REPO = args.flags.repo;
const FAILURE = args.flags.failure;
if (!REPO || !FAILURE) {
	process.stderr.write('Usage: --repo <path> --failure <text> [--top-k 10] [--lines-per-file 30] [--provider anthropic|openai] [--model id]\n');
	process.exit(2);
}
const REPO_ABS = realpathSync(REPO);
const TOP_K = Number(args.flags['top-k'] ?? 10);
const LINES_PER_FILE = Number(args.flags['lines-per-file'] ?? 30);
const PROVIDER = args.flags.provider ?? 'anthropic';
const MODEL = args.flags.model ?? (PROVIDER === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini');

// ---------------------------------------------------------------------------
// Walker (mirrors llm-codebase-baseline.mjs)
// ---------------------------------------------------------------------------

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const PY_EXT = new Set(['.py', '.pyi']);
const IGNORE_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo',
	'coverage', '__pycache__', '.venv', 'venv', 'env', '.tox',
]);

function loadGitignorePatterns(repoRoot) {
	const path = join(repoRoot, '.gitignore');
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, 'utf8')
			.split('\n')
			.map((l) => l.replace(/#.*$/, '').trim())
			.filter((l) => l && !l.startsWith('!'));
	} catch { return []; }
}

function makeIgnoreMatcher(patterns) {
	const compiled = patterns.map((raw) => {
		let p = raw;
		const dirOnly = p.endsWith('/');
		if (dirOnly) p = p.slice(0, -1);
		const anchored = p.startsWith('/');
		if (anchored) p = p.slice(1);
		const reBody = p.split('/').map((seg) =>
			seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'),
		).join('/');
		const re = anchored ? new RegExp(`^${reBody}(/|$)`) : new RegExp(`(^|/)${reBody}(/|$)`);
		return { re, dirOnly };
	});
	return (relPath, isDir) => {
		for (const { re, dirOnly } of compiled) {
			if (dirOnly && !isDir) continue;
			if (re.test(relPath)) return true;
		}
		return false;
	};
}

function languageOf(path) {
	const dot = path.lastIndexOf('.');
	if (dot < 0) return null;
	const ext = path.slice(dot).toLowerCase();
	if (TS_EXT.has(ext)) return 'typescript';
	if (PY_EXT.has(ext)) return 'python';
	return null;
}

function walk(repoRoot) {
	const matcher = makeIgnoreMatcher(loadGitignorePatterns(repoRoot));
	const out = [];
	const seen = new Set();
	const visit = (absDir) => {
		let real;
		try { real = realpathSync(absDir); } catch { return; }
		if (seen.has(real)) return;
		seen.add(real);
		let entries;
		try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const ent of entries) {
			const abs = join(absDir, ent.name);
			const rel = relative(repoRoot, abs).split(sep).join(posix.sep);
			if (rel.startsWith('..') || rel === '') continue;
			if (ent.isDirectory()) {
				if (IGNORE_DIRS.has(ent.name)) continue;
				if (matcher(rel + '/', true)) continue;
				visit(abs);
			} else if (ent.isFile()) {
				if (matcher(rel, false)) continue;
				const lang = languageOf(rel);
				if (lang) out.push({ relPath: rel, absPath: abs, language: lang });
			}
		}
	};
	visit(repoRoot);
	return out;
}

// ---------------------------------------------------------------------------
// BM25-lite (same as llm-codebase-baseline.mjs)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
	'a','an','and','are','as','at','be','been','but','by','do','does','for','from','has','have','how','i','in','is','it','its','me','my','no','not','of','on','or','should','so','such','than','that','the','their','them','then','there','these','they','this','to','was','wasnt','we','were','what','when','where','which','while','who','why','will','with','would','you','your','about','after','before','because','being','can','could','did','done','during','if','into','more','most','only','other','same','some','such','too','very','very',
]);

function tokenize(text) {
	const tokens = new Set();
	for (const m of text.matchAll(/"([^"]+)"|'([^']+)'/g)) {
		const v = (m[1] ?? m[2] ?? '').trim();
		if (v.length >= 2) tokens.add(v.toLowerCase());
	}
	for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
		const t = m[0].toLowerCase();
		if (STOPWORDS.has(t)) continue;
		tokens.add(t);
		const pieces = m[0]
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
			.split(/[_\s]+/);
		for (const p of pieces) {
			const lc = p.toLowerCase();
			if (lc.length < 3) continue;
			if (STOPWORDS.has(lc)) continue;
			tokens.add(lc);
		}
	}
	return tokens;
}

function fileHaystack(file, maxLines) {
	let body = '';
	try { body = readFileSync(file.absPath, 'utf8').split('\n').slice(0, maxLines).join('\n'); } catch {}
	return file.relPath + '\n' + body;
}

function rankFiles(files, failureTokens, maxLines) {
	const scored = files.map((file) => {
		const hayTokens = tokenize(fileHaystack(file, maxLines));
		let overlap = 0;
		for (const t of failureTokens) if (hayTokens.has(t)) overlap++;
		const lenPenalty = 1 + Math.log(1 + hayTokens.size / 100);
		return { file, score: overlap / lenPenalty, overlap };
	});
	scored.sort((a, b) => b.score - a.score);
	return scored;
}

// ---------------------------------------------------------------------------
// cgrca enrichment via the built dist modules
// ---------------------------------------------------------------------------

async function enrichCandidates(repoRoot, ranked) {
	// Script lives at <repo>/tools/eval/llm-codebase-enriched-baseline.mjs.
	// Walk up to repo root, then into packages/core/dist for the built modules.
	const here = dirname(fileURLToPath(import.meta.url));
	const distRoot = join(here, '..', '..', 'packages', 'core', 'dist');
	const { indexScope } = await import(pathToFileURL(join(distRoot, 'graph', 'orchestrator.js')).href);
	const { symbolsInFile } = await import(pathToFileURL(join(distRoot, 'graph', 'queries.js')).href);

	const filePaths = ranked.map((r) => r.file.relPath);
	const indexed = await indexScope({ repoRoot, scope: filePaths, maxFiles: filePaths.length + 50 });
	try {
		const enriched = [];
		for (const r of ranked) {
			// File-level enrichment ONLY — no symbol-picking. Iter 1's
			// "largest function" heuristic poisoned the LLM's pick on
			// 3 bugs (events-503, pr25-await, postmortem) by showing
			// callers/callees of the WRONG symbol. Lesson: don't pre-pick;
			// give the LLM the whole file's symbol list and let it choose.
			const syms = (symbolsInFile(indexed.db, r.file.relPath) ?? [])
				.filter((s) =>
					s.kind === 'function' || s.kind === 'method' ||
					s.kind === 'class' || s.kind === 'const' ||
					s.kind === 'interface' || s.kind === 'type' || s.kind === 'enum',
				)
				.map((s) => ({ name: s.name, kind: s.kind, startLine: s.startLine, endLine: s.endLine }))
				.sort((a, b) => a.startLine - b.startLine);

			// Recent commits at the FILE level (not per-symbol). cgrca's
			// recentlyChangedNear is symbol-scoped; for file-level we shell
			// out to git log directly. Cheap, no daemon, gives provenance.
			let recent = [];
			try {
				const { spawnSync } = await import('node:child_process');
				const r2 = spawnSync(
					'git',
					['log', '--no-merges', '-n', '5', '--pretty=format:%h\t%ad\t%an\t%s', '--date=short', '--', r.file.relPath],
					{ cwd: repoRoot, encoding: 'utf8', timeout: 5000 },
				);
				if (r2.status === 0 && r2.stdout) {
					recent = r2.stdout.trim().split('\n').filter(Boolean).map((line) => {
						const [commit, date, author, ...rest] = line.split('\t');
						return { commit, date, author, subject: rest.join('\t') };
					});
				}
			} catch {}

			enriched.push({
				file: r.file.relPath,
				score: r.score,
				overlap: r.overlap,
				language: r.file.language,
				symbols: syms.slice(0, 30),  // cap to keep prompt size bounded
				symbolCount: syms.length,
				recent,
			});
		}
		return enriched;
	} finally {
		indexed.db.close();
	}
}

// ---------------------------------------------------------------------------
// LLM call (mirrors llm-codebase-baseline.mjs)
// ---------------------------------------------------------------------------

async function callAnthropic({ system, user, model, maxOutputTokens }) {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
	const t0 = Date.now();
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model,
			max_tokens: maxOutputTokens,
			system: system + '\n\nRespond with valid JSON only. No prose, no code fences.',
			messages: [{ role: 'user', content: user }],
		}),
	});
	const ms = Date.now() - t0;
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`anthropic HTTP ${res.status}: ${text.slice(0, 300)}`);
	}
	const json = await res.json();
	const content = json.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
	return { content, inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens, latencyMs: ms, model: json.model };
}

async function callOpenAI({ system, user, model, maxOutputTokens }) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY not set');
	const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
	const t0 = Date.now();
	const res = await fetch(`${base}/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model,
			max_tokens: maxOutputTokens,
			messages: [
				{ role: 'system', content: system + '\n\nRespond with valid JSON only.' },
				{ role: 'user', content: user },
			],
			response_format: { type: 'json_object' },
		}),
	});
	const ms = Date.now() - t0;
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`openai HTTP ${res.status}: ${text.slice(0, 300)}`);
	}
	const json = await res.json();
	return { content: json.choices[0]?.message?.content ?? '', inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens, latencyMs: ms, model: json.model };
}

const PRICING = {
	'claude-opus-4-7': { in: 15, out: 75 },
	'claude-sonnet-4-6': { in: 3, out: 15 },
	'claude-haiku-4-5-20251001': { in: 1, out: 5 },
	'gpt-4o': { in: 2.5, out: 10 },
	'gpt-4o-mini': { in: 0.15, out: 0.6 },
};
function costUsd(model, inT, outT) {
	const p = PRICING[model];
	if (!p) return 0;
	return (inT / 1e6) * p.in + (outT / 1e6) * p.out;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM = `You are an RCA assistant. You will receive (a) a failure description, (b) a ranked list of candidate files retrieved by full-text search, and (c) for each file, two structural facts from a code knowledge graph: the list of every function/method/class defined in the file (with line ranges) and the last 5 commits touching the file.

Use the file content (path + body snippet) to find the right file, then use the symbol list to pick a specific line/symbol within it, and use the recent-commit history to weight files that were recently modified in the same neighborhood as the failure.

Rules:
- Pick from the candidate set. Do NOT invent file paths not in the list.
- The line/symbol you return MUST appear in the candidate's symbol list (or be visible in the body snippet).
- If no candidate is plausible, set rootCause to null and explain in reasoning.
- Confidence is honest: 0.9 = very sure, 0.5 = best guess, 0.2 = grasping at straws. Don't anchor at 0.7.`;

function renderUserPrompt(failure, enriched) {
	const parts = [];
	parts.push('## Failure');
	parts.push(failure.trim());
	parts.push('');
	parts.push('## Candidates (BM25 retrieval + cgrca file-level structural facts)');
	for (let i = 0; i < enriched.length; i++) {
		const c = enriched[i];
		parts.push('');
		parts.push(`### Candidate ${i + 1}: ${c.file}  (BM25 overlap=${c.overlap}, score=${c.score.toFixed(2)})`);
		if (c.symbols && c.symbols.length > 0) {
			const symStr = c.symbols.map((s) => `${s.name} (${s.kind} @ L${s.startLine}-${s.endLine})`).join(', ');
			const more = c.symbolCount > c.symbols.length ? ` … +${c.symbolCount - c.symbols.length} more` : '';
			parts.push(`Symbols in this file: ${symStr}${more}`);
		}
		if (c.recent && c.recent.length > 0) {
			parts.push(`Recent commits touching this file:`);
			for (const r of c.recent) {
				parts.push(`  - ${r.commit} ${r.date} (${r.author}): ${r.subject}`);
			}
		}
		// File body snippet (same shape llm-codebase shows — first N lines)
		let body = '';
		try {
			body = readFileSync(join(REPO_ABS, c.file), 'utf8').split('\n').slice(0, LINES_PER_FILE).join('\n');
		} catch {}
		if (body) {
			parts.push('Body (first ' + LINES_PER_FILE + ' lines):');
			parts.push('```' + (c.language ?? ''));
			parts.push(body);
			parts.push('```');
		}
	}
	parts.push('');
	parts.push('## Output');
	parts.push('Respond as JSON only:');
	parts.push('```json');
	parts.push(`{
  "rootCause": {
    "file": "<path relative to repo root>",
    "line": <int>,
    "symbol": "<name from the symbol list>",
    "hypothesis": "<≤3 sentences>",
    "confidence": <0..1>
  } | null,
  "alternatives": [{ "file": "...", "line": 0, "symbol": "...", "why": "..." }],
  "reasoning": "<1-2 sentences>"
}`);
	parts.push('```');
	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const failureTokens = tokenize(FAILURE);
const allFiles = walk(REPO_ABS);
const ranked = rankFiles(allFiles, failureTokens, LINES_PER_FILE).slice(0, TOP_K);

const enriched = await enrichCandidates(REPO_ABS, ranked);

const userPrompt = renderUserPrompt(FAILURE, enriched);

const callFn = PROVIDER === 'openai' ? callOpenAI : callAnthropic;
const llmRes = await callFn({
	system: SYSTEM,
	user: userPrompt,
	model: MODEL,
	maxOutputTokens: 1500,
});

let verdict = { rootCause: null, alternatives: [], reasoning: '' };
try {
	const cleaned = llmRes.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
	const parsed = JSON.parse(cleaned);
	verdict = {
		rootCause: parsed.rootCause ?? null,
		alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives : [],
		reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
	};
} catch (err) {
	process.stderr.write(`baseline: verdict parse failed (${err.message})\n`);
}

const out = {
	verdict,
	provider: PROVIDER,
	model: llmRes.model,
	cost: { inputTokens: llmRes.inputTokens, outputTokens: llmRes.outputTokens, usd: costUsd(llmRes.model, llmRes.inputTokens, llmRes.outputTokens) },
	latencyMs: llmRes.latencyMs,
	retrievedFiles: enriched.map((r) => ({ file: r.file, score: r.score, overlap: r.overlap, symbol: r.symbol })),
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
