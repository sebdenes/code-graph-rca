# Contributing to Halo

Welcome. Halo is a code knowledge graph + RCA engine shipped as three packages
(`code-graph-rca`, `code-graph-rca-ui`, `code-graph-rca-github-app`) with binaries
`cgrca`, `cgrca-view`, and `cgrca-pr-review`. We treat contributions the same way
we treat the tool itself: small, scoped, honest, and tested. If you found a bug or
have a feature in mind, open an issue first so we can scope it together.

## Development setup

```sh
git clone https://github.com/sebdenes/code-graph-rca.git
cd code-graph-rca
npm install                # installs all three workspaces from root
npm test -ws --if-present  # run the full suite across packages
```

Per-workspace iteration:

```sh
npm -w packages/core test
npm -w packages/ui run dev
npm -w packages/github-app test
```

## Branching and PRs

- Branch off `main`. Use a short, descriptive name (`fix/ui-topbar-collapse`,
  `feat/core-python-decorators`).
- Open PRs against `main`. Squash-merge is the default.
- Non-trivial PRs need at least one reviewer. Tag the maintainer.
- Keep PRs small and scoped — one concern per PR. New language support, new query,
  parser fix, resolver heuristic, UI polish — split them up.

## Commit style

Imperative, scoped, lowercase scope in parens:

```
fix(ui): collapse double topbars in AppShell
feat(core): resolve Python decorators across modules
docs: rewrite README around the Halo wedge
```

Pair-programmed commits use the `Co-Authored-By:` trailer convention you'll see
throughout `git log`. Keep that convention when an agent or another human
collaborated on the change.

## Test bar

The current bar is **all 329 tests across the three packages must stay green**.
New features ship with new tests. Bug fixes ship with a regression test that
fails before the fix and passes after. The CI workflow under `.github/workflows/`
runs the same suite — if it's red there, it's red here.

## Code style

- **Strict TypeScript.** `tsconfig.json` enables `strict` and
  `noUncheckedIndexedAccess`. Don't loosen it; fix the call site.
- **No `any` without a one-line comment** explaining why the type is genuinely
  unknowable at that boundary.
- **Regex-only highlighter** for the side panel in the UI. We deliberately do
  not pull `shiki` (or any tokenizer with a wasm/JSON payload) into that path —
  the side panel needs to stay cheap to render.
- **Honest fallbacks over silent failure.** If you can't resolve a thing, mark
  it unresolved at lower confidence and surface it. Don't fabricate.

## Calibration corpus

Halo's RCA ranking weights are fit on a corpus of real incidents. If you change
a feature that feeds the ranker — a new edge type, a new heuristic, a new
confidence — refit the weights and include the new `fit.out.json` in your PR.
See [`tools/calibration/README.md`](tools/calibration/README.md) for the corpus
layout, `collect.mjs` / `score.mjs` / `fit.mjs` workflow, and how to add new
incidents without leaking proprietary code.

## Reporting bugs and asking questions

- Bugs: use the bug report template under `.github/ISSUE_TEMPLATE/`.
- Features: use the feature request template.
- Questions, design discussions, "is this a good fit": open a Discussion.
- Security: see [`SECURITY.md`](SECURITY.md). Do **not** open a public issue.

By contributing you agree your contributions are licensed under the MIT
License that covers the rest of the project.
