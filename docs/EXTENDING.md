# Extending: adding a language

The extractor is grammar-agnostic — it reads tree-sitter query matches and routes them by capture name. A new language is a `.scm` file plus a few lines of dispatch. This guide assumes you have the grammar as a `.wasm` (easiest source: the `tree-sitter-wasms` npm package). TypeScript and Python illustrate the conventions.

## Capture-name conventions

The extractor in `src/graph/parser/extract.ts` looks for a fixed set of capture names. Your `.scm` file must use these exactly. Names are lowercase, dot-separated, and grouped by purpose.

### Symbols

| Capture | Meaning |
| --- | --- |
| `@symbol.function` | Top-level function declaration (outer node) |
| `@symbol.method` | Method inside a class body (outer node) |
| `@symbol.class` | Class declaration |
| `@symbol.interface` | Interface declaration (TS only in v1) |
| `@symbol.const` | Top-level const/let bound to a function value |
| `@symbol.enum` | Enum declaration |
| `@symbol.type` | Type alias declaration |
| `@symbol.name` | The identifier of the symbol (always required) |
| `@symbol.parent` | Enclosing class name when the symbol is a method |
| `@symbol.exported` | Marker on the outer `export_statement` (presence implies exported) |

Every symbol-defining match must include exactly one `@symbol.name`. If `@symbol.method` and `@symbol.function` fire on the same node (Python does this), the extractor prefers `@symbol.method` — see `pickPrimarySymbolCapture` in `extract.ts`.

### Edges

| Capture | Meaning |
| --- | --- |
| `@call.callee` | Callee identifier or property name on a call expression |
| `@call.object` | Receiver of a member-expression call |
| `@extends.target` | Base class identifier |
| `@implements.target` | Implemented interface identifier |

Calls are anchored to the smallest enclosing function/method/class/const symbol by source range. The receiver is captured but not yet used cross-file (see README Limitations).

### Imports

| Capture | Meaning |
| --- | --- |
| `@import.named` | Named import binding |
| `@import.default` | Default import binding |
| `@import.namespace` | `* as ns` style binding |
| `@import.alias` | Local alias name when renaming |
| `@import.source` | Module specifier string |

Each `@import.source` match should include exactly one of `@import.named`, `@import.default`, or `@import.namespace`. The extractor strips quotes from the source automatically.

## Dispatch: `pickGrammar` and `languageOf`

Two functions decide which grammar parses a file:

- `pickGrammar(relPath)` in `src/graph/parser/extract.ts` returns the grammar name. Add extensions here.
- `languageOf(path)` in `src/graph/walker.ts` returns the `Language` union value. Add extensions here, and add the union arm in `src/types.ts`.

Strict TypeScript will fail to compile every `switch` over `Language` until you handle the new arm. That is the safety net.

## How the resolver handles imports

Cross-file resolution lives in `src/graph/resolve.ts`. The resolver branches on `fromFile.language`:

- **TypeScript**: relative imports resolve against the importing file's directory, trying TS/JS extensions and `index.*` for directories. Workspace-package imports look up `package.json` `name` fields scanned at index time.
- **Python**: relative imports honor leading dots, climbing one directory per dot beyond the first. Absolute imports resolve against package roots — directories with `__init__.py` whose parent has none.

For a new language, add a branch with the equivalent rules. If you skip this, same-file edges still resolve and cross-file calls land at confidence 0.5 with `resolved=false`. That is a working — if degraded — first cut.

## What to test

Drop a tiny fixture under `test/fixtures/<lang>-tiny/` and add `test/graph/<lang>.test.ts`. Mirror `test/graph/python.test.ts` for shape. The minimum coverage:

1. A function definition is extracted with the right name, line range, and exported flag.
2. A method definition is extracted with the right `parent` class.
3. A direct call inside a function produces a CALLS edge with the right `to_name`.
4. A relative import resolves to the right target file across files.
5. An unresolvable call lands at confidence 0.5 with `resolved=false` — not silently dropped.

The fifth case is the load-bearing one. The whole architecture leans on unresolved-but-visible edges; a parser that drops them quietly is worse than one that does nothing.
