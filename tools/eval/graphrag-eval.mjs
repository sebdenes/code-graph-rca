#!/usr/bin/env node
/**
 * GraphRAG eval for cgrca.
 *
 * Tests cgrca as a graph-context provider for an LLM agent doing RCA, NOT as
 * a ranker. Each corpus entry: agent receives failure prose + tools (cgrca
 * MCP-style + optionally grep), explores the codebase, outputs ranked fix
 * file candidates. Score against ground-truth fix_files.
 *
 * Modes (--modes graphrag,grep,both,none):
 *   graphrag  agent has cgrca tools only (definitionOf, callersOf, calleesOf,
 *             recentlyChangedNear, symbolsInFile)
 *   grep      agent has grep + ls + read tools (file-content baseline)
 *   both      agent has both toolsets — tests if graph adds value over grep
 *   none      LLM-only baseline (no exploration tools)
 *
 * Env: ANTHROPIC_API_KEY required.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (!args.flags.repo || !args.flags.corpus) {
  console.error('Usage: --repo <path> --corpus <jsonl> [--modes graphrag,grep,both,none] [--limit N] [--model claude-sonnet-4-6] [--out path.json]');
  process.exit(2);
}
const REPO = resolve(args.flags.repo);
const CORPUS = resolve(args.flags.corpus);
const MODES = (args.flags.modes ?? 'graphrag,grep,both,none').split(',').map(s => s.trim());
const LIMIT = args.flags.limit ? parseInt(args.flags.limit, 10) : Infinity;
const MODEL = args.flags.model ?? 'claude-sonnet-4-6';
const CGRCA = args.flags.cgrca ?? resolve('packages/core/dist/cli.js');
const OUT = args.flags.out ?? `/tmp/graphrag-eval-${Date.now()}.json`;
const MAX_TURNS = parseInt(args.flags['max-turns'] ?? '20', 10);
const VERBOSE = !!args.flags.verbose;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i+1];
      if (!next || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    }
  }
  return { flags };
}

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic Tool Use format)
// ---------------------------------------------------------------------------

const CGRCA_TOOLS = [
  {
    name: 'cgrca_definitionOf',
    description: 'Find the definition(s) of a symbol by name. Returns file path, lines, signature.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string', description: 'Symbol name (function, class, etc.)' }
    }, required: ['name'] },
  },
  {
    name: 'cgrca_callersOf',
    description: 'Find functions/methods that call the given symbol. depth=2 by default.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string' }, depth: { type: 'integer', default: 2 }
    }, required: ['name'] },
  },
  {
    name: 'cgrca_calleesOf',
    description: 'Find functions/methods called by the given symbol.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string' }, depth: { type: 'integer', default: 1 }
    }, required: ['name'] },
  },
  {
    name: 'cgrca_recentlyChangedNear',
    description: 'Get recent git commits that touched the lines containing this symbol.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string' }, sinceDays: { type: 'integer', default: 90 }
    }, required: ['name'] },
  },
  {
    name: 'cgrca_symbolsInFile',
    description: 'List all symbols defined in a file. Useful for orienting in unknown code.',
    input_schema: { type: 'object', properties: {
      path: { type: 'string' }
    }, required: ['path'] },
  },
];

const GREP_TOOLS = [
  {
    name: 'grep',
    description: 'Search file contents for a pattern using grep. Returns matching files and lines.',
    input_schema: { type: 'object', properties: {
      pattern: { type: 'string', description: 'regex pattern' },
      glob: { type: 'string', description: 'optional glob filter, e.g. "*.py"' }
    }, required: ['pattern'] },
  },
  {
    name: 'list_files',
    description: 'List files in a directory of the repo.',
    input_schema: { type: 'object', properties: {
      path: { type: 'string', description: 'directory path relative to repo root, default "."' }
    } },
  },
  {
    name: 'read_file',
    description: 'Read a slice of a file. Lines are 1-indexed.',
    input_schema: { type: 'object', properties: {
      path: { type: 'string' },
      start: { type: 'integer', default: 1 },
      end: { type: 'integer', default: 200 }
    }, required: ['path'] },
  },
];

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

function runCgrca(subcommand, args, timeout = 30000) {
  const result = spawnSync('node', [CGRCA, subcommand, ...args, '--repo', REPO], {
    encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return { error: `cgrca ${subcommand} exit ${result.status}: ${(result.stderr || '').slice(0, 300)}` };
  }
  return parseJsonOrText(result.stdout);
}

function parseJsonOrText(s) {
  s = s.trim();
  if (!s) return { result: '' };
  try { return JSON.parse(s); }
  catch { return { text: s.slice(0, 4000) }; }
}

function runGrep(pattern, glob) {
  const cmd = ['grep', '-rln', '-E', pattern, '.'];
  if (glob) { cmd.splice(2, 0, '--include', glob); }
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: REPO, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== 1) {
    return { error: `grep exit ${result.status}` };
  }
  const matches = (result.stdout || '').trim().split('\n').filter(Boolean).slice(0, 50);
  return { matches };
}

function runListFiles(path) {
  const target = resolve(REPO, path || '.');
  if (!target.startsWith(REPO)) return { error: 'path escapes repo' };
  const result = spawnSync('ls', ['-1', target], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) return { error: `ls failed` };
  return { files: (result.stdout || '').trim().split('\n').slice(0, 100) };
}

function runReadFile(path, start = 1, end = 200) {
  const target = resolve(REPO, path);
  if (!target.startsWith(REPO)) return { error: 'path escapes repo' };
  let txt = '';
  try { txt = readFileSync(target, 'utf8'); }
  catch (e) { return { error: `read failed: ${e.message}` }; }
  const lines = txt.split('\n');
  const sliced = lines.slice(Math.max(0, start - 1), end);
  return { content: sliced.join('\n').slice(0, 8000), totalLines: lines.length };
}

function dispatchTool(name, input) {
  switch (name) {
    case 'cgrca_definitionOf':       return runCgrca('define',   [input.name, '--format', 'json']);
    case 'cgrca_callersOf':          return runCgrca('callers',  [input.name, '-d', String(input.depth ?? 2), '--format', 'json']);
    case 'cgrca_calleesOf':          return runCgrca('callees',  [input.name, '-d', String(input.depth ?? 1), '--format', 'json']);
    case 'cgrca_recentlyChangedNear':return runCgrca('changed',  [input.name, '--since', String(input.sinceDays ?? 90), '--format', 'json']);
    case 'cgrca_symbolsInFile':      return runCgrca('rca',      [`file:${input.path}`, '--format', 'json', '--top-n', '50']);
    case 'grep':                     return runGrep(input.pattern, input.glob);
    case 'list_files':               return runListFiles(input.path);
    case 'read_file':                return runReadFile(input.path, input.start, input.end);
    default:                         return { error: `unknown tool ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Anthropic API call with tool loop
// ---------------------------------------------------------------------------

async function anthropicCall(messages, tools, system) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const body = { model: MODEL, max_tokens: 4096, system, messages };
  if (tools && tools.length) body.tools = tools;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

async function runAgent(prose, modeTools, modeName) {
  const tools = [];
  if (modeTools.includes('cgrca')) tools.push(...CGRCA_TOOLS);
  if (modeTools.includes('grep')) tools.push(...GREP_TOOLS);

  const system = [
    'You are a root-cause-analysis assistant. Given a failure description, identify the file(s) in the codebase that need to be fixed.',
    tools.length
      ? `You have tools to explore the codebase. You have ${MAX_TURNS} turns total. Form a hypothesis FAST (within 3-5 tool calls), then commit to an answer. Over-exploration is worse than a confident guess.`
      : 'You have no exploration tools. Reason from the failure description alone.',
    'OUTPUT FORMAT: When ready, emit:',
    '<answer>{"ranked_files": ["path1.py", "path2.py", ...]}</answer>',
    'Repo-relative paths. Most-likely fix file FIRST. Up to 10 files.',
    'Always include an <answer> by the last turn even if uncertain — partial credit beats no credit.',
  ].join('\n');

  const messages = [{ role: 'user', content: `Failure description:\n\n${prose}\n\nFind the file(s) that need to be fixed.` }];

  let totalIn = 0, totalOut = 0, turns = 0, toolCallCount = 0;
  let lastText = '';
  for (turns = 0; turns < MAX_TURNS; turns++) {
    const resp = await anthropicCall(messages, tools, system);
    totalIn += resp.usage.input_tokens;
    totalOut += resp.usage.output_tokens;
    messages.push({ role: 'assistant', content: resp.content });
    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (text) lastText = text;

    if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'stop_sequence') {
      return { ranked: parseAnswer(text), turns, toolCalls: toolCallCount, in: totalIn, out: totalOut };
    }
    if (resp.stop_reason !== 'tool_use') {
      return { ranked: parseAnswer(text), turns, toolCalls: toolCallCount, in: totalIn, out: totalOut };
    }

    const toolUses = resp.content.filter(b => b.type === 'tool_use');
    const turnsLeft = MAX_TURNS - turns - 1;
    const toolResults = toolUses.map(tu => {
      toolCallCount++;
      if (VERBOSE) process.stderr.write(`    [${modeName}] ${tu.name}(${JSON.stringify(tu.input).slice(0,80)})\n`);
      const result = dispatchTool(tu.name, tu.input);
      // Truncate aggressively — full results bloat history; agent saw key info on first read.
      let content = JSON.stringify(result);
      if (content.length > 4000) content = content.slice(0, 4000) + '\n...[truncated]';
      return { type: 'tool_result', tool_use_id: tu.id, content };
    });
    const userBlocks = [...toolResults];
    if (turnsLeft <= 3 && turnsLeft > 0) {
      userBlocks.push({ type: 'text',
        text: `[REMINDER: ${turnsLeft} turn(s) left. Commit to an <answer> NOW based on what you have. No more exploration.]` });
    }
    messages.push({ role: 'user', content: userBlocks });
  }
  // Final salvage: ask for an answer directly with no tools.
  messages.push({ role: 'user', content: 'You exhausted your exploration budget. Output your best <answer> now using only what you already learned. Do not call tools.' });
  try {
    const resp = await anthropicCall(messages, [], system);
    totalIn += resp.usage.input_tokens;
    totalOut += resp.usage.output_tokens;
    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    return { ranked: parseAnswer(text) || parseAnswer(lastText), turns, toolCalls: toolCallCount, in: totalIn, out: totalOut, salvaged: true };
  } catch {
    return { ranked: parseAnswer(lastText), turns, toolCalls: toolCallCount, in: totalIn, out: totalOut, error: 'max turns + salvage failed' };
  }
}

function parseAnswer(text) {
  const m = text.match(/<answer>([\s\S]*?)<\/answer>/);
  if (!m) return [];
  try {
    const obj = JSON.parse(m[1].trim());
    return Array.isArray(obj.ranked_files) ? obj.ranked_files : [];
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function normalize(p) { return p.replace(/^\.?\//, '').toLowerCase(); }

function coverage(ranked, targets, k) {
  if (!targets.length) return 0;
  const top = new Set(ranked.slice(0, k).map(normalize));
  const ts = targets.map(normalize);
  // Allow basename match too — agent may not know the prefix.
  let hit = 0;
  for (const t of ts) {
    if (top.has(t)) { hit++; continue; }
    const tBase = t.split('/').pop();
    for (const r of top) {
      if (r === t) { hit++; break; }
      if (r.split('/').pop() === tBase) { hit++; break; }
    }
  }
  return hit / ts.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const corpus = readFileSync(CORPUS, 'utf8').trim().split('\n').map(JSON.parse).slice(0, LIMIT);

const MODE_TOOLS = {
  graphrag: ['cgrca'],
  grep: ['grep'],
  both: ['cgrca', 'grep'],
  none: [],
};

const results = { mode: {}, perEntry: [] };
for (const m of MODES) results.mode[m] = { top1: [], top5: [], turns: [], toolCalls: [], in: 0, out: 0, errors: 0 };

const t0 = Date.now();
for (let i = 0; i < corpus.length; i++) {
  const e = corpus[i];
  const prose = e.failure_description || e.failure_prose || '';
  const targets = e.fix_files || [];
  if (!prose || !targets.length) continue;

  console.log(`[${i+1}/${corpus.length}] ${e.id}  fix=${JSON.stringify(targets)}`);
  const perEntry = { id: e.id, targets, modes: {} };

  for (const m of MODES) {
    try {
      const r = await runAgent(prose, MODE_TOOLS[m], m);
      const t1 = coverage(r.ranked, targets, 1);
      const t5 = coverage(r.ranked, targets, 5);
      results.mode[m].top1.push(t1);
      results.mode[m].top5.push(t5);
      results.mode[m].turns.push(r.turns);
      results.mode[m].toolCalls.push(r.toolCalls);
      results.mode[m].in += r.in;
      results.mode[m].out += r.out;
      perEntry.modes[m] = { ranked: r.ranked, top1: t1, top5: t5, turns: r.turns, toolCalls: r.toolCalls };
      console.log(`    ${m.padEnd(8)} top1=${t1.toFixed(2)} top5=${t5.toFixed(2)} turns=${r.turns} tools=${r.toolCalls} ranked[0..2]=${r.ranked.slice(0,3)}`);
    } catch (err) {
      results.mode[m].errors++;
      perEntry.modes[m] = { error: String(err) };
      console.log(`    ${m} ERROR: ${err.message}`);
    }
  }
  results.perEntry.push(perEntry);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n=== GraphRAG eval results (n=${results.perEntry.length}, ${elapsed}s) ===`);
console.log(`${'mode'.padEnd(10)} ${'top-1'.padStart(8)} ${'top-5'.padStart(8)} ${'turns'.padStart(8)} ${'tools'.padStart(8)} ${'in_tok'.padStart(10)} ${'out_tok'.padStart(10)} ${'errors'.padStart(8)}`);
for (const m of MODES) {
  const s = results.mode[m];
  const n = s.top1.length || 1;
  const avg = (a) => (a.reduce((x,y)=>x+y,0)/n).toFixed(3);
  console.log(`${m.padEnd(10)} ${avg(s.top1).padStart(8)} ${avg(s.top5).padStart(8)} ${avg(s.turns).padStart(8)} ${avg(s.toolCalls).padStart(8)} ${String(s.in).padStart(10)} ${String(s.out).padStart(10)} ${String(s.errors).padStart(8)}`);
}
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`\nFull results: ${OUT}`);
