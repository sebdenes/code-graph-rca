# Contributing

## Project layout

```
src/
  index.ts              public API surface
  types.ts              shared row + result types
  graph/
    orchestrator.ts     indexScope: walk -> extract -> resolve
    scope.ts            resolveScope: failure -> seed file set
    walker.ts           filesystem walk, gitignore, language detection
    parser/
      extract.ts        tree-sitter -> ExtractedFile
      loader.ts         grammar + query loading (web-tree-sitter)
      queries/
        typescript.scm  TS/TSX/JS captures
        python.scm      Python captures
    resolve.ts          second-pass edge resolution (same-file, self/this, imports)
    queries.ts          definitionOf / callersOf / calleesOf / symbolsInFile / recentlyChangedNear
    db.ts               better-sqlite3 wrapper
    schema.sql          files / symbols / edges / imports
  rca/
    runner.ts           runRca: scope → index → 5 queries → prompt
    context.ts          graph-context block formatter
    prompt.ts           default RCA prompt template + protocol
  cli.ts                `cgrca` entry point
test/
  smoke.test.ts
  graph/
    queries.test.ts
    scope.test.ts
    python.test.ts
    git-change.test.ts
  fixtures/
    ts-tiny/
    ts-monorepo/
    py-package/
docs/
  ARCHITECTURE.md
  RCA_PROTOCOL.md
  EXTENDING.md
```

Both the library API (`src/index.ts` re-exports `indexScope`, `runRca`, and the five queries) and the `cgrca` CLI (`src/cli.ts`) ship in v1. End-to-end tests live in `test/rca/runner.test.ts` and `test/cli.test.ts`.

## Running tests

```sh
npm test            # one-shot
npm run test:watch  # vitest in watch mode
npm run typecheck   # strict TS, no emit
npm run build       # compile to dist/ and copy .scm + wasm assets
```

Tests use vitest and run against fixture repos under `test/fixtures/`. Add a fixture rather than mutating an existing one when your test introduces new shape.

## How to add a language

The graph is grammar-driven. Adding a language is mostly declarative.

1. **Drop the grammar wasm into the resolution path.** Prefer pinning via [`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms) when it ships your grammar; otherwise add the `.wasm` next to the existing ones and update `src/graph/parser/loader.ts` to find it.
2. **Add a `.scm` query file** under `src/graph/parser/queries/<lang>.scm` using the documented capture names (`@symbol.function`, `@symbol.method`, `@symbol.class`, `@symbol.name`, `@symbol.parent`, `@symbol.exported`, `@call.callee`, `@call.object`, `@extends.target`, `@implements.target`, `@import.named`, `@import.default`, `@import.namespace`, `@import.alias`, `@import.source`). See `docs/EXTENDING.md` for the full reference and an annotated example.
3. **Extend language detection** in two places: `pickGrammar` in `src/graph/parser/extract.ts` (extension -> grammar name) and `languageOf` in `src/graph/walker.ts` (extension -> `Language`).
4. **Update the `Language` union** in `src/types.ts`. Strict TS means everything that branches on language will fail to compile until you handle the new arm — that is the point.
5. **Add a fixture and a test.** Drop a tiny project under `test/fixtures/<lang>-tiny/` and write a test in `test/graph/<lang>.test.ts` that asserts a definition, a call edge, and an import resolve correctly. Mirror the shape of `test/graph/python.test.ts`.

The cross-file import resolver in `src/graph/resolve.ts` currently special-cases TypeScript and Python. New languages will fall through to "no cross-file resolution" until you add a branch — which is acceptable: same-file edges still resolve, and unresolved edges land at confidence 0.5 rather than disappearing.

## Coding standards

- **Strict TypeScript.** `tsconfig.json` enables strict mode and `noUncheckedIndexedAccess`. Don't loosen it; fix the call site.
- **No comments-as-bandage.** If a comment is explaining why something looks broken, the code is broken — fix it. Comments should explain non-obvious *intent*, not paper over confusion.
- **Honest fallbacks over silent failure.** If you can't resolve a thing, mark it unresolved with a lower confidence and surface it. Don't fabricate.
- **RCA protocol on bugs.** When fixing a non-trivial bug, follow the seven-step protocol in `docs/RCA_PROTOCOL.md`. The protocol is the same one this tool produces for downstream agents — we hold ourselves to it.

## Pull requests

Keep them small and scoped. New language support, new query, parser fix, resolver heuristic — one concern per PR. Include the fixture and the test. If you change a capture name in a `.scm` file, update both `extract.ts` and `docs/EXTENDING.md` in the same commit.
