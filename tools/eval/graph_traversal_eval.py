#!/usr/bin/env python3
"""
Graph-traversal eval for cgrca.

Tests whether cgrca's graph reaches co-modified fix files from a seed file,
vs random/same-dir/co-change baselines.

Usage:
  CGRCA_EVAL_REPO=/path/to/target/repo \
  CGRCA_EVAL_SAMPLE=/path/to/sample.json \
  python3 graph_traversal_eval.py

The sample file is a JSON list of [sha, [file1, file2, ...]] entries
produced by mining `git log --name-only` for multi-file commits in the
target repo. file[0] is treated as the seed; file[1..n] as the targets.
"""
import json, subprocess, os, random, sys, time
from collections import defaultdict, Counter

REPO   = os.environ.get('CGRCA_EVAL_REPO')
CGRCA  = os.environ.get('CGRCA_BIN', 'packages/core/dist/cli.js')
SAMPLE = os.environ.get('CGRCA_EVAL_SAMPLE')
TOP_N_QUERY = 30
KS = [1, 5, 10]

random.seed(42)

if not REPO or not SAMPLE:
    print('Set CGRCA_EVAL_REPO and CGRCA_EVAL_SAMPLE.', file=sys.stderr)
    sys.exit(2)

def list_repo_files():
    out = subprocess.check_output(
        ['git', '-C', REPO, 'ls-files', '*.py'], text=True)
    return [l for l in out.splitlines() if l]

def file_cochange_index(repo_files):
    print('  building cochange index...', flush=True)
    out = subprocess.check_output(
        ['git', '-C', REPO, 'log', '--since=2024-01-01', '--no-merges',
         '--pretty=format:COMMIT', '--name-only', '--', '*.py'], text=True)
    cur = []
    cooccur = defaultdict(Counter)
    fileset = set(repo_files)
    for line in out.splitlines():
        if line == 'COMMIT':
            for a in cur:
                for b in cur:
                    if a != b: cooccur[a][b] += 1
            cur = []
        elif line and line in fileset:
            cur.append(line)
    return cooccur

def cgrca_rca_files(seed_file, top_n=TOP_N_QUERY):
    try:
        out = subprocess.run(
            ['node', CGRCA, 'rca', f'file:{seed_file}',
             '--repo', REPO, '--format', 'json', '--top-n', str(top_n)],
            capture_output=True, text=True, timeout=60)
        if out.returncode != 0: return []
        o = json.loads(out.stdout)
        seen, ranked = set(), []
        for c in o.get('causalCandidates', []):
            f = c.get('file')
            if f and f != seed_file and f not in seen:
                seen.add(f); ranked.append(f)
        return ranked
    except Exception as e:
        print(f'    cgrca err {seed_file}: {e}', flush=True)
        return []

def baseline_random(seed, all_files, k):
    pool = [f for f in all_files if f != seed]
    return random.sample(pool, min(k, len(pool)))

def baseline_samedir(seed, all_files, k):
    d = os.path.dirname(seed)
    siblings = sorted([f for f in all_files
                       if os.path.dirname(f) == d and f != seed])
    return siblings[:k]

def baseline_cochange(seed, cooccur, k):
    return [f for f, _ in cooccur.get(seed, Counter()).most_common(k)]

def coverage(ranked, targets, k):
    if not targets: return 0.0
    topk = set(ranked[:k])
    return sum(1 for t in targets if t in topk) / len(targets)

def main():
    sample = json.load(open(SAMPLE))
    all_files = list_repo_files()
    cooccur = file_cochange_index(all_files)

    methods = ['cgrca', 'random', 'samedir', 'cochange']
    scores = {m: {k: [] for k in KS} for m in methods}

    print(f'\nRunning eval on {len(sample)} commits...', flush=True)
    t0 = time.time()
    for i, (sha, files) in enumerate(sample, 1):
        seed, targets = files[0], files[1:]
        cgrca_ranked = cgrca_rca_files(seed, top_n=max(KS))
        rand_ranked  = baseline_random(seed, all_files, max(KS))
        sdir_ranked  = baseline_samedir(seed, all_files, max(KS))
        cch_ranked   = baseline_cochange(seed, cooccur, max(KS))
        for k in KS:
            scores['cgrca'][k].append(coverage(cgrca_ranked, targets, k))
            scores['random'][k].append(coverage(rand_ranked, targets, k))
            scores['samedir'][k].append(coverage(sdir_ranked, targets, k))
            scores['cochange'][k].append(coverage(cch_ranked, targets, k))
        if i % 10 == 0:
            elapsed = time.time() - t0
            print(f'  {i}/{len(sample)}  ({elapsed:.0f}s, {elapsed/i:.1f}s/commit)', flush=True)

    print(f'\n=== Graph-traversal eval results (n={len(sample)}) ===\n')
    print(f"{'method':<10} {'top-1':>8} {'top-5':>8} {'top-10':>8}")
    for m in methods:
        row = [f'{sum(scores[m][k])/len(scores[m][k]):.3f}' for k in KS]
        print(f'{m:<10} {row[0]:>8} {row[1]:>8} {row[2]:>8}')

    out_path = os.environ.get('CGRCA_EVAL_OUT', '/tmp/graph_eval_results.json')
    json.dump({m: {str(k): scores[m][k] for k in KS} for m in methods},
              open(out_path, 'w'))
    print(f'\nRaw scores saved to {out_path}')

if __name__ == '__main__':
    main()
