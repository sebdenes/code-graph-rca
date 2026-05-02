#!/usr/bin/env node
// tools/eval/llm-codebase-baseline.mjs
//
// "@codebase-style" baseline for the v0.5 Phase 2/4 kill criterion gate.
//
// What it does (per the v0.5 plan):
//   1. Scan the repo's parseable source files (gitignore-respecting walker).
//   2. BM25-lite retrieval: rank files by token overlap between the failure
//      description and (path + first 50 lines of file content).
//   3. Send the top-K files (default 20) with their first-30-lines snippet
//      to the LLM, asking it to pick a (file, line, symbol) root cause.
//      Same JSON schema as cgrca's --llm.
//   4. Print the result as JSON on stdout (parsed by run-eval.mjs's
//      llm-codebase mode).
//
// This is the strongest "no graph, just LLM + retrieval" comparator we can
// build cheaply, mimicking what Cursor's @codebase / similar embedding
// retrievers do in production. Cgrca's --llm must beat this by >=10pp top-1
// to validate the graph-walk RCA bet (per docs/v0.5-plan.md Phase 4).
//
// Usage:
//   node tools/eval/llm-codebase-baseline.mjs \
//        --repo <path> \
//        --failure <text> \
//        [--top-k 20] [--lines-per-file 30] \
//        [--provider anthropic|openai] [--model <id>]
//
// Auth via env: ANTHROPIC_API_KEY (default) or OPENAI_API_KEY [+ OPENAI_BASE_URL].
//
// Zero npm deps (matching the rest of tools/eval). The LLM call is a
// duplicate of packages/core/src/rca/llm/anthropic.ts in plain JS — the
// harness is a node script, not a TypeScript module, so we accept the
// duplication rather than build a dual-target shim.

import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';

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
	process.stderr.write('Usage: --repo <path> --failure <text> [--top-k 20] [--lines-per-file 30] [--provider anthropic|openai] [--model id]\n');
	process.exit(2);
}
const REPO_ABS = realpathSync(REPO);
const TOP_K = Number(args.flags['top-k'] ?? 20);
const LINES_PER_FILE = Number(args.flags['lines-per-file'] ?? 30);
const PROVIDER = args.flags.provider ?? 'anthropic';
const MODEL = args.flags.model ?? (PROVIDER === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini');

// ---------------------------------------------------------------------------
// Walker — gitignore-respecting, mirrors packages/core/src/graph/walker.ts
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
	} catch {
		return [];
	}
}

function makeIgnoreMatcher(patterns) {
	// Tiny gitignore matcher — supports leading-slash anchoring, trailing-slash
	// dir-only, and `*` wildcards inside a path segment. Not a full impl
	// (no negation, no character classes), but enough to skip the same dirs
	// that walker.ts's `ignore` package would.
	const compiled = patterns.map((raw) => {
		let p = raw;
		const dirOnly = p.endsWith('/');
		if (dirOnly) p = p.slice(0, -1);
		const anchored = p.startsWith('/');
		if (anchored) p = p.slice(1);
		// Convert glob → regex. Anchor to start if leading-slash; otherwise
		// allow it to match anywhere in the path.
		const reBody = p
			.split('/')
			.map((seg) =>
				seg
					.replace(/[.+^${}()|[\]\\]/g, '\\$&')
					.replace(/\*\*/g, '.*')
					.replace(/\*/g, '[^/]*')
					.replace(/\?/g, '[^/]'),
			)
			.join('/');
		const re = anchored
			? new RegExp(`^${reBody}(/|$)`)
			: new RegExp(`(^|/)${reBody}(/|$)`);
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
	const patterns = loadGitignorePatterns(repoRoot);
	const matcher = makeIgnoreMatcher(patterns);
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
// BM25-lite retrieval
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
	'the', 'a', 'an', 'is', 'was', 'are', 'were', 'when', 'then', 'this',
	'that', 'for', 'with', 'and', 'or', 'but', 'not', 'no', 'as', 'at',
	'by', 'in', 'on', 'of', 'to', 'from', 'it', 'its', 'be', 'been',
	'being', 'has', 'have', 'had', 'can', 'could', 'should', 'would',
	'will', 'does', 'did', 'do', 'one', 'two', 'three', 'which', 'what',
	'why', 'how', 'where', 'who', 'about', 'after', 'before', 'because',
]);

function tokenize(text) {
	const tokens = new Set();
	// Quoted literals
	for (const m of text.matchAll(/"([^"]+)"|'([^']+)'/g)) {
		const v = (m[1] ?? m[2] ?? '').trim();
		if (v.length >= 2) tokens.add(v.toLowerCase());
	}
	// Identifiers (camelCase + snake_case + plain words), length >= 3
	for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
		const t = m[0].toLowerCase();
		if (STOPWORDS.has(t)) continue;
		tokens.add(t);
		// Sub-words: split camelCase + snake_case the same way splitCompound does
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
	try {
		body = readFileSync(file.absPath, 'utf8').split('\n').slice(0, maxLines).join('\n');
	} catch {}
	return file.relPath + '\n' + body;
}

function rankFiles(files, failureTokens, maxLines) {
	const scored = files.map((file) => {
		const hayTokens = tokenize(fileHaystack(file, maxLines));
		let overlap = 0;
		for (const t of failureTokens) if (hayTokens.has(t)) overlap++;
		// BM25-lite: penalize very long files (more tokens = higher noise floor).
		const lenPenalty = 1 + Math.log(1 + hayTokens.size / 100);
		return { file, score: overlap / lenPenalty, overlap };
	});
	scored.sort((a, b) => b.score - a.score);
	return scored;
}

// ---------------------------------------------------------------------------
// LLM call (provider-specific, plain JS)
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
	const content = json.content
		.filter((b) => b.type === 'text')
		.map((b) => b.text ?? '')
		.join('');
	return {
		content,
		inputTokens: json.usage.input_tokens,
		outputTokens: json.usage.output_tokens,
		latencyMs: ms,
		model: json.model,
	};
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
	return {
		content: json.choices[0]?.message?.content ?? '',
		inputTokens: json.usage.prompt_tokens,
		outputTokens: json.usage.completion_tokens,
		latencyMs: ms,
		model: json.model,
	};
}

// Pricing — kept in sync with packages/core/src/rca/llm/provider.ts.
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

const SYSTEM = `You are an RCA assistant. You will receive (a) a failure description and (b) a ranked list of source files retrieved by a generic full-text search. Your job: pick the single most likely root cause file, line, and symbol — or honestly say no candidate is plausible.

Rules:
- Pick from the file set. Do NOT invent file paths not in the list.
- If no file is plausible, set rootCause to null and explain in reasoning.
- Be specific: hypothesis must reference the failure's specific symptom + the picked code path, not a generic "this function might be wrong".
- Confidence is honest: 0.9 = very sure, 0.5 = best guess, 0.2 = grasping at straws. Don't anchor at 0.7.`;

function renderUserPrompt(failure, ranked, linesPerFile) {
	const parts = [];
	parts.push('## Failure');
	parts.push(failure.trim());
	parts.push('');
	parts.push('## Files (retrieved by token overlap)');
	for (let i = 0; i < ranked.length; i++) {
		const r = ranked[i];
		let body = '';
		try {
			body = readFileSync(r.file.absPath, 'utf8').split('\n').slice(0, linesPerFile).join('\n');
		} catch {}
		parts.push('');
		parts.push(`### File ${i + 1}: ${r.file.relPath}  (overlap=${r.overlap}, score=${r.score.toFixed(2)})`);
		parts.push('```' + r.file.language);
		parts.push(body);
		parts.push('```');
	}
	parts.push('');
	parts.push('## Output');
	parts.push('Respond as JSON only, matching this schema exactly:');
	parts.push('```json');
	parts.push(`{
  "rootCause": {
    "file": "<path relative to repo root>",
    "line": <int>,
    "symbol": "<name>",
    "hypothesis": "<≤3 sentences>",
    "confidence": <0..1>
  } | null,
  "alternatives": [{ "file": "...", "line": 0, "symbol": "...", "why": "..." }],
  "reasoning": "<1-2 sentences on which file(s) you weighed>"
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

const userPrompt = renderUserPrompt(FAILURE, ranked, LINES_PER_FILE);

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
	cost: {
		inputTokens: llmRes.inputTokens,
		outputTokens: llmRes.outputTokens,
		usd: costUsd(llmRes.model, llmRes.inputTokens, llmRes.outputTokens),
	},
	latencyMs: llmRes.latencyMs,
	retrievedFiles: ranked.map((r) => ({ file: r.file.relPath, score: r.score, overlap: r.overlap })),
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
