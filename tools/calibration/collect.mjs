#!/usr/bin/env node
// tools/calibration/collect.mjs
//
// Build a labeled (failure -> known-correct fix location) corpus for cgrca's
// causal scorer calibration. Mines merged "fix" PRs (and bug-closing PRs)
// from configured GitHub repos via the gh CLI, derives the fix's primary
// changed symbol from the merge commit diff, and writes one JSONL row per
// usable PR into ./corpus.jsonl.
//
// No npm deps. Uses gh + git via child_process.
//
// Idempotent: rows already present (by `id`) are skipped on rerun. Failures
// (PRs we can't process) are persisted as `{ id, error }` rows so we don't
// retry them.

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, 'corpus.jsonl');
const CGRCA_CLI = join(__dirname, '..', '..', 'packages', 'core', 'dist', 'cli.js');

// --- repo configuration ---------------------------------------------------
// localPath: optional. If set, we drive symbol extraction off the local
// clone (faster, complete history). Otherwise we fetch diffs via `gh`.
const REPOS = [
	{
		slug: 'sebdenes/code-graph-rca',
		localPath: '/Users/I048171/code-graph-rca',
		prLimit: 100,
		// Many of the early fixes landed as direct commits on `main` rather
		// than via PRs. After the gh-PR scan we also walk `git log` for
		// fix-style commits and ingest those that map to a code change.
		gitLogFallback: true,
		gitLogLimit: 50,
	},
	{
		slug: 'sebdenes/athlai',
		localPath: '/Users/I048171/Athlai-Antigravity/athlai',
		prLimit: 200,
		gitLogFallback: true,
		gitLogLimit: 120,
	},
];

const FIX_TITLE_RE = /^(fix|bug)(\(|:|\s)/i;
const CODE_EXT_RE = /\.(ts|tsx|js|mjs|cjs|jsx|py|go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp)$/i;
const SKIP_PATH_RE = /(^|\/)(CHANGELOG|README|version|VERSION)(\.|$)|^docs\/|\/docs\/|\.md$|\.json$|\.lock$|^_design\//i;

// --- helpers --------------------------------------------------------------

function sh(cmd, opts = {}) {
	return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function shTry(cmd, opts = {}) {
	try {
		return sh(cmd, opts);
	} catch {
		return null;
	}
}

function loadExistingIds() {
	if (!existsSync(CORPUS_PATH)) return new Set();
	const ids = new Set();
	const raw = readFileSync(CORPUS_PATH, 'utf8');
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line);
			if (obj && obj.id) ids.add(obj.id);
		} catch {
			// ignore corrupt line
		}
	}
	return ids;
}

function appendRow(row) {
	appendFileSync(CORPUS_PATH, JSON.stringify(row) + '\n');
}

function listFixPrs(repoSlug, limit) {
	const out = sh(
		`gh pr list --repo ${repoSlug} --state merged --limit ${limit} --json number,title,mergeCommit,closingIssuesReferences,body`,
	);
	const prs = JSON.parse(out);
	// Filter: title looks like a fix, OR PR closes a "bug"-labeled issue.
	return prs.filter((p) => {
		if (!p.mergeCommit?.oid) return false;
		if (FIX_TITLE_RE.test(p.title)) return true;
		const refs = p.closingIssuesReferences || [];
		return refs.length > 0;
	});
}

function fetchIssueBody(repoSlug, issueNumber) {
	const out = shTry(`gh issue view ${issueNumber} --repo ${repoSlug} --json body,title,labels`);
	if (!out) return null;
	try {
		return JSON.parse(out);
	} catch {
		return null;
	}
}

// Parse `git show --numstat` to get files + their churn.
function parseNumstat(repoPath, sha) {
	const out = shTry(`git -C ${repoPath} show --no-color --format= --numstat ${sha}`);
	if (!out) return [];
	const files = [];
	for (const line of out.split('\n')) {
		if (!line.trim()) continue;
		const m = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
		if (!m) continue;
		const added = m[1] === '-' ? 0 : parseInt(m[1], 10);
		const removed = m[2] === '-' ? 0 : parseInt(m[2], 10);
		const path = m[3];
		files.push({ path, added, removed, churn: added + removed });
	}
	return files;
}

// Use git's hunk header `@@ -a,b +c,d @@ context` — the trailing context is
// usually the enclosing function name in TS/Python/Go/etc. (git uses the
// language's funcname pattern via gitattributes).
function extractSymbolsFromDiff(repoPath, sha, file) {
	const out = shTry(
		`git -C ${repoPath} show --no-color --unified=0 --format= ${sha} -- ${JSON.stringify(file)}`,
	);
	if (!out) return [];
	const symbols = new Map();
	for (const line of out.split('\n')) {
		const m = line.match(/^@@ .+? @@\s*(.*)$/);
		if (!m) continue;
		const ctx = m[1].trim();
		if (!ctx) continue;
		// Heuristic: extract a function/class/method identifier.
		// Match patterns like `def foo(`, `function foo(`, `foo = (`,
		// `class Foo:`, `async function foo`, `const foo = (`,
		// `export function foo`, `private foo(`, `void foo(`, etc.
		const sym = pickSymbolName(ctx);
		if (!sym) continue;
		symbols.set(sym, (symbols.get(sym) || 0) + 1);
	}
	return [...symbols.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([name]) => name);
}

function pickSymbolName(ctx) {
	// Python
	let m = ctx.match(/\b(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
	if (m) return m[1];
	// TS / JS function decls + arrow assignments
	m = ctx.match(/\bfunction\s+([A-Za-z_$][\w$]*)/);
	if (m) return m[1];
	m = ctx.match(/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
	if (m) return m[1];
	// Class method shape: `methodName(args)` or `async methodName(`
	m = ctx.match(/\b(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/);
	if (m) return m[1];
	// Plain `name(` at start
	m = ctx.match(/^([A-Za-z_$][\w$]*)\s*\(/);
	if (m) return m[1];
	return null;
}

function pickPrimarySymbol(repoPath, sha, files) {
	// Try each candidate file ranked by churn; first that yields a symbol wins.
	for (const f of files) {
		const syms = extractSymbolsFromDiff(repoPath, sha, f.path);
		if (syms.length > 0) {
			return { fixSymbol: syms[0], fixSymbolFile: f.path, allSymbols: syms };
		}
	}
	return { fixSymbol: null, fixSymbolFile: null, allSymbols: [] };
}

function symbolExistsAt(repoPath, parentSha, symbol, file) {
	if (!symbol) return false;
	// Cheap test: grep for the identifier in the file at parentSha. We accept
	// any occurrence — cgrca's index-time symbol resolver does the heavy
	// lifting, we just need confidence the symbol predates the fix.
	const out = shTry(
		`git -C ${repoPath} show ${parentSha}:${file} 2>/dev/null | grep -nE "\\b${symbol.replace(/[^\w$]/g, '')}\\b"`,
		{ shell: '/bin/bash' },
	);
	return !!out && out.trim().length > 0;
}

// Synthesize a cgrca-input-shaped failure description from the commit body
// + closing-issue body. Priority:
//   1. closing-issue body (if any) — that's the real failure description.
//   2. commit message body — contains repro / log / "Live prod ..." in our repos.
//   3. the commit subject as last resort.
function buildFailureText({ commitSubject, commitBody, issueBodies }) {
	const parts = [];
	if (issueBodies.length > 0) parts.push(...issueBodies);
	if (commitBody && commitBody.trim()) parts.push(commitBody.trim());
	if (parts.length === 0) parts.push(commitSubject);
	return parts.join('\n\n---\n\n').slice(0, 4000);
}

function commitInfo(repoPath, sha) {
	const subject = shTry(`git -C ${repoPath} log -1 --format=%s ${sha}`)?.trim() || '';
	const body = shTry(`git -C ${repoPath} log -1 --format=%b ${sha}`)?.trim() || '';
	const parent = shTry(`git -C ${repoPath} log -1 --format=%P ${sha}`)?.trim().split(/\s+/)[0] || '';
	return { subject, body, parent };
}

function processRepo(repo, existingIds) {
	console.error(`\n[${repo.slug}] listing merged PRs...`);
	let prs;
	try {
		prs = listFixPrs(repo.slug, repo.prLimit);
	} catch (e) {
		console.error(`[${repo.slug}] failed to list PRs: ${e.message}`);
		return { added: 0, errors: 0, skipped: 0 };
	}
	console.error(`[${repo.slug}] ${prs.length} candidate fix PRs`);

	let added = 0,
		errors = 0,
		skipped = 0;

	for (const pr of prs) {
		const id = `${repo.slug}#${pr.number}`;
		if (existingIds.has(id)) {
			skipped++;
			continue;
		}

		try {
			const sha = pr.mergeCommit.oid;
			const repoPath = repo.localPath;
			if (!repoPath || !existsSync(repoPath)) {
				appendRow({ id, error: `local clone missing: ${repoPath}` });
				existingIds.add(id);
				errors++;
				continue;
			}

			// Make sure the SHA exists locally; if not, try to fetch.
			const has = shTry(`git -C ${repoPath} cat-file -e ${sha}^{commit} 2>/dev/null && echo ok`);
			if (!has) {
				shTry(`git -C ${repoPath} fetch origin ${sha} --depth 50 2>/dev/null`);
				const reHas = shTry(`git -C ${repoPath} cat-file -e ${sha}^{commit} 2>/dev/null && echo ok`);
				if (!reHas) {
					appendRow({ id, error: `commit ${sha} not in local clone` });
					existingIds.add(id);
					errors++;
					continue;
				}
			}

			// Files changed (filter: code only, skip docs/changelog/lockfiles).
			const allFiles = parseNumstat(repoPath, sha);
			const codeFiles = allFiles
				.filter((f) => CODE_EXT_RE.test(f.path) && !SKIP_PATH_RE.test(f.path))
				.sort((a, b) => b.churn - a.churn);

			if (codeFiles.length === 0) {
				appendRow({ id, error: 'no code files changed (docs/changelog only)' });
				existingIds.add(id);
				errors++;
				continue;
			}

			const { fixSymbol, fixSymbolFile, allSymbols } = pickPrimarySymbol(repoPath, sha, codeFiles);
			const { subject, body, parent } = commitInfo(repoPath, sha);

			if (!parent) {
				appendRow({ id, error: 'parent commit unresolved (root commit?)' });
				existingIds.add(id);
				errors++;
				continue;
			}

			// Try to use the closing-issue body for failure_text if available.
			const issueBodies = [];
			for (const ref of pr.closingIssuesReferences || []) {
				if (!ref.number) continue;
				const issue = fetchIssueBody(repo.slug, ref.number);
				if (issue?.body) issueBodies.push(issue.body);
			}

			// Symbol-existence sanity check at parent commit.
			let symbolOk = false;
			if (fixSymbol && fixSymbolFile) {
				symbolOk = symbolExistsAt(repoPath, parent, fixSymbol, fixSymbolFile);
			}

			if (!fixSymbol) {
				appendRow({
					id,
					error: 'could not extract primary symbol from diff hunks',
					fix_files: codeFiles.map((f) => f.path),
					fix_commit: sha,
				});
				existingIds.add(id);
				errors++;
				continue;
			}

			if (!symbolOk) {
				// Symbol added in this commit (i.e. the fix introduced it). For
				// calibration we want pre-existing symbols only — record as a
				// soft-skip so we don't retry, but with diagnostic info.
				appendRow({
					id,
					error: `fix_symbol "${fixSymbol}" not found at parent ${parent}:${fixSymbolFile} (likely added by fix)`,
					fix_commit: sha,
					fix_files: codeFiles.map((f) => f.path),
				});
				existingIds.add(id);
				errors++;
				continue;
			}

			const failureText = buildFailureText({
				commitSubject: subject,
				commitBody: body,
				issueBodies,
			});

			const row = {
				id,
				repo: repo.slug,
				pr_number: pr.number,
				fix_commit: sha,
				parent_commit: parent,
				fix_files: codeFiles.map((f) => f.path),
				fix_symbol: fixSymbol,
				fix_symbol_file: fixSymbolFile,
				all_changed_symbols: allSymbols,
				fix_summary: subject,
				failure_text: failureText,
				cgrca_input: `symbol:${fixSymbol}`,
				closing_issues: (pr.closingIssuesReferences || []).map((r) => r.number),
			};

			appendRow(row);
			existingIds.add(id);
			added++;
			console.error(`[${repo.slug}] +${id} symbol=${fixSymbol} (${codeFiles.length}f)`);
		} catch (e) {
			appendRow({ id, error: `processing failed: ${e.message}` });
			existingIds.add(id);
			errors++;
		}
	}

	if (repo.gitLogFallback && repo.localPath && existsSync(repo.localPath)) {
		const fb = processGitLogFallback(repo, existingIds);
		added += fb.added;
		errors += fb.errors;
		skipped += fb.skipped;
	}

	return { added, errors, skipped };
}

// Walk `git log --all` for fix-style commits not already covered by a merged
// PR row. Each commit becomes a corpus entry with id `<repo>@<short-sha>`.
function processGitLogFallback(repo, existingIds) {
	console.error(`\n[${repo.slug}] git-log fallback (limit=${repo.gitLogLimit})...`);
	const repoPath = repo.localPath;
	// Format: <sha>\x1f<subject>
	const out = shTry(
		`git -C ${repoPath} log --all --no-merges --format=%H%x1f%s -n ${repo.gitLogLimit * 4}`,
	);
	if (!out) return { added: 0, errors: 0, skipped: 0 };

	const lines = out
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);

	let added = 0,
		errors = 0,
		skipped = 0;

	for (const line of lines) {
		const idx = line.indexOf('\x1f');
		if (idx === -1) continue;
		const sha = line.slice(0, idx);
		const subject = line.slice(idx + 1);
		if (!FIX_TITLE_RE.test(subject)) continue;

		const shortSha = sha.slice(0, 12);
		const id = `${repo.slug}@${shortSha}`;
		if (existingIds.has(id)) {
			skipped++;
			continue;
		}
		// Skip if the same commit already landed as a PR row.
		// (We already added all listed PR mergeCommits in the previous pass;
		// they live under `<slug>#<num>` and don't collide.)
		if (added >= repo.gitLogLimit) break;

		try {
			const allFiles = parseNumstat(repoPath, sha);
			const codeFiles = allFiles
				.filter((f) => CODE_EXT_RE.test(f.path) && !SKIP_PATH_RE.test(f.path))
				.sort((a, b) => b.churn - a.churn);

			if (codeFiles.length === 0) {
				appendRow({ id, error: 'no code files changed (docs/changelog only)' });
				existingIds.add(id);
				errors++;
				continue;
			}

			const { fixSymbol, fixSymbolFile, allSymbols } = pickPrimarySymbol(repoPath, sha, codeFiles);
			const { body, parent } = commitInfo(repoPath, sha);

			if (!parent) {
				appendRow({ id, error: 'parent commit unresolved' });
				existingIds.add(id);
				errors++;
				continue;
			}
			if (!fixSymbol) {
				appendRow({
					id,
					error: 'could not extract primary symbol from diff hunks',
					fix_commit: sha,
					fix_files: codeFiles.map((f) => f.path),
				});
				existingIds.add(id);
				errors++;
				continue;
			}
			if (!symbolExistsAt(repoPath, parent, fixSymbol, fixSymbolFile)) {
				appendRow({
					id,
					error: `fix_symbol "${fixSymbol}" not found at parent ${parent}:${fixSymbolFile}`,
					fix_commit: sha,
					fix_files: codeFiles.map((f) => f.path),
				});
				existingIds.add(id);
				errors++;
				continue;
			}

			const failureText = buildFailureText({
				commitSubject: subject,
				commitBody: body,
				issueBodies: [],
			});

			const row = {
				id,
				repo: repo.slug,
				pr_number: null,
				fix_commit: sha,
				parent_commit: parent,
				fix_files: codeFiles.map((f) => f.path),
				fix_symbol: fixSymbol,
				fix_symbol_file: fixSymbolFile,
				all_changed_symbols: allSymbols,
				fix_summary: subject,
				failure_text: failureText,
				cgrca_input: `symbol:${fixSymbol}`,
				closing_issues: [],
				source: 'git-log-fallback',
			};
			appendRow(row);
			existingIds.add(id);
			added++;
			console.error(`[${repo.slug}] +${id} symbol=${fixSymbol} (${codeFiles.length}f)`);
		} catch (e) {
			appendRow({ id, error: `processing failed: ${e.message}` });
			existingIds.add(id);
			errors++;
		}
	}

	return { added, errors, skipped };
}

// --- enrichment: add cgrca_input_caller / cgrca_input_trace --------------
//
// Each row in corpus.jsonl uses `cgrca_input = symbol:<fix_symbol>` which
// makes the fix the anchor (distance=0, proximity 2.5). That inflates
// top-1. To exercise the ranker we add a second input that does NOT name
// the fix_symbol:
//   - cgrca_input_trace  if failure_text looks like a stack trace
//   - cgrca_input_caller = symbol:<one-hop caller of fix_symbol> (via the
//     graph at parent_commit), or a sibling symbol in the same file as a
//     last resort.
//   - unanchored_input = null + reason  if neither shape works

const REPO_PATHS = {
	'sebdenes/code-graph-rca': '/Users/I048171/code-graph-rca',
	'sebdenes/athlai': '/Users/I048171/Athlai-Antigravity/athlai',
};

const TRACE_RE = /(File "[^"]+", line \d+)|(at [\w$.<>]+ \([^)]+:\d+(?::\d+)?\))|(Traceback \(most recent call last\))|(\bat .+:\d+:\d+)/;

function looksLikeTrace(text) {
	if (!text || text.length < 20) return false;
	return TRACE_RE.test(text);
}

function setupWorktree(repoPath, sha) {
	const wt = mkdtempSync(join(tmpdir(), `cgrca-enrich-${sha.slice(0, 8)}-`));
	const r = shTry(`git -C ${repoPath} worktree add --detach ${wt} ${sha}`);
	if (!r && !existsSync(join(wt, '.git'))) {
		try { rmSync(wt, { recursive: true, force: true }); } catch {}
		return null;
	}
	return wt;
}
function teardownWorktree(repoPath, wt) {
	shTry(`git -C ${repoPath} worktree remove --force ${wt}`);
	try { rmSync(wt, { recursive: true, force: true }); } catch {}
}

// Use cgrca CLI to look up callers of fix_symbol at parent_commit.
// Pass --persist <dbPath> so the index is reused across multiple lookups
// in the same worktree.
function callersAt(worktree, symbol, dbPath) {
	const persistArg = dbPath ? `--persist ${JSON.stringify(dbPath)}` : '';
	const out = shTry(`node ${CGRCA_CLI} callers ${JSON.stringify(symbol)} --repo ${JSON.stringify(worktree)} ${persistArg} 2>/dev/null`, { timeout: 120000 });
	if (!out) return [];
	try {
		const obj = JSON.parse(out);
		return obj.callers ?? [];
	} catch {
		return [];
	}
}

// Find a sibling symbol (other function/class in the same file at parent).
function siblingSymbol(repoPath, parentSha, file, fixSymbol) {
	const src = shTry(`git -C ${repoPath} show ${parentSha}:${JSON.stringify(file).slice(1, -1)}`, { shell: '/bin/bash' });
	if (!src) return null;
	// Cheap heuristic: extract def/function/class identifiers, return the first one != fixSymbol.
	const names = new Set();
	for (const line of src.split('\n')) {
		const py = line.match(/^\s*(?:async\s+def|def|class)\s+([A-Za-z_][\w]*)/);
		if (py) names.add(py[1]);
		const ts1 = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
		if (ts1) names.add(ts1[1]);
		const ts2 = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/);
		if (ts2) names.add(ts2[1]);
		const ts3 = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
		if (ts3) names.add(ts3[1]);
	}
	for (const n of names) if (n !== fixSymbol) return n;
	return null;
}

function enrichAll() {
	if (!existsSync(CORPUS_PATH)) {
		console.error('no corpus.jsonl to enrich; run collect first');
		return;
	}
	const lines = readFileSync(CORPUS_PATH, 'utf8').split('\n').filter((l) => l.trim());
	const rows = lines.map((l) => JSON.parse(l));
	const out = [];
	let nTrace = 0, nCaller = 0, nSibling = 0, nNone = 0, nSkipped = 0;
	const TMPDIR = mkdtempSync(join(tmpdir(), 'cgrca-trace-'));

	// Group rows by (repo, parent_commit) so we set up each worktree once.
	const groups = new Map();
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		if (r.error) { out.push(r); continue; }
		if (r.cgrca_input_caller || r.cgrca_input_trace || r.unanchored_input === null) {
			// Already enriched.
			out.push(r);
			nSkipped++;
			continue;
		}
		const key = `${r.repo}@@${r.parent_commit}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(i);
	}

	// Pre-fill out[] with placeholders for unprocessed rows so we can patch.
	for (let i = 0; i < rows.length; i++) {
		if (out[i] === undefined) out[i] = rows[i];
	}

	let g = 0;
	for (const [key, idxs] of groups) {
		g++;
		const [slug, parent] = key.split('@@');
		const repoPath = REPO_PATHS[slug];
		console.error(`[${g}/${groups.size}] ${slug}@${parent.slice(0, 8)} (${idxs.length} rows)`);
		if (!repoPath) {
			for (const i of idxs) out[i] = { ...rows[i], unanchored_input: null, unanchored_reason: 'unknown repo' };
			continue;
		}
		const wt = setupWorktree(repoPath, parent);
		if (!wt) {
			for (const i of idxs) out[i] = { ...rows[i], unanchored_input: null, unanchored_reason: 'worktree setup failed' };
			continue;
		}
		const dbPath = join(wt, '.cgrca-cal.sqlite');
		try {
			for (const i of idxs) {
				const r = rows[i];
				const enriched = { ...r };
				// 1. trace?
				if (looksLikeTrace(r.failure_text)) {
					const tracePath = join(TMPDIR, `${r.id.replace(/[\/#@]/g, '_')}.trace.txt`);
					writeFileSync(tracePath, r.failure_text);
					enriched.cgrca_input_trace = tracePath;
					nTrace++;
					out[i] = enriched;
					continue;
				}
				// 2. caller?
				const callers = callersAt(wt, r.fix_symbol, dbPath);
				const callerNames = callers.map((c) => c.name).filter((n) => n !== r.fix_symbol);
				if (callerNames.length > 0) {
					enriched.cgrca_input_caller = `symbol:${callerNames[0]}`;
					enriched.cgrca_input_caller_via = 'callersOf';
					nCaller++;
					out[i] = enriched;
					continue;
				}
				// 3. sibling?
				const sib = siblingSymbol(repoPath, parent, r.fix_symbol_file, r.fix_symbol);
				if (sib) {
					enriched.cgrca_input_caller = `symbol:${sib}`;
					enriched.cgrca_input_caller_via = 'sibling';
					nSibling++;
					out[i] = enriched;
					continue;
				}
				// 4. give up
				enriched.unanchored_input = null;
				enriched.unanchored_reason = 'no trace, no caller, no sibling';
				out[i] = enriched;
				nNone++;
			}
		} finally {
			teardownWorktree(repoPath, wt);
		}
	}

	// Rewrite corpus.
	writeFileSync(CORPUS_PATH, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
	console.error(`enrichment done. trace=${nTrace} caller=${nCaller} sibling=${nSibling} none=${nNone} skipped=${nSkipped}`);
}

function main() {
	mkdirSync(__dirname, { recursive: true });
	if (process.argv.includes('--enrich')) {
		enrichAll();
		return;
	}
	const existing = loadExistingIds();
	console.error(`existing rows: ${existing.size}`);

	const totals = { added: 0, errors: 0, skipped: 0 };
	for (const repo of REPOS) {
		const r = processRepo(repo, existing);
		totals.added += r.added;
		totals.errors += r.errors;
		totals.skipped += r.skipped;
	}

	console.error(
		`\ndone. added=${totals.added} errors=${totals.errors} skipped(existing)=${totals.skipped}`,
	);
	console.error(`corpus: ${CORPUS_PATH}`);
}

main();
