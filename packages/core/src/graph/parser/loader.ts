import { Parser, Language, Query } from "web-tree-sitter";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

let parserInitPromise: Promise<void> | null = null;

/**
 * The build copies parser+grammar wasms to dist/wasm/. Prefer that bundled
 * location at runtime so the package can ship with no node_modules
 * resolution at the deploy target. Fall back to node_modules for dev.
 */
function bundledWasmDir(): string | null {
  // src/graph/parser/loader.ts → ../../wasm
  // dist/graph/parser/loader.js → ../../wasm
  const candidate = join(here, "..", "..", "wasm");
  if (existsSync(candidate)) return candidate;
  return null;
}

function parserWasmPath(): string {
  const bundled = bundledWasmDir();
  if (bundled) {
    // 0.26 renamed the runtime wasm asset from `tree-sitter.wasm` to
    // `web-tree-sitter.wasm`. Accept either name in the bundled dir for
    // forward/backward compatibility during the migration window.
    const p = join(bundled, "web-tree-sitter.wasm");
    if (existsSync(p)) return p;
    const legacy = join(bundled, "tree-sitter.wasm");
    if (existsSync(legacy)) return legacy;
  }
  // 0.26's package.json restricts subpath access via `exports`, but the wasm
  // is itself an exported subpath — resolve it directly. Fall back to the
  // legacy 0.24 asset name for forward compatibility.
  try {
    return requireFromHere.resolve("web-tree-sitter/web-tree-sitter.wasm");
  } catch {
    return requireFromHere.resolve("web-tree-sitter/tree-sitter.wasm");
  }
}

function grammarWasmPath(name: string): string {
  const bundled = bundledWasmDir();
  if (bundled) {
    const p = join(bundled, `tree-sitter-${name}.wasm`);
    if (existsSync(p)) return p;
  }
  // @vscode/tree-sitter-wasm has no `exports` map, so package.json resolves
  // fine and we can derive the wasm/ directory from there.
  const pkgPath = requireFromHere.resolve("@vscode/tree-sitter-wasm/package.json");
  return join(dirname(pkgPath), "wasm", `tree-sitter-${name}.wasm`);
}

export async function initParser(): Promise<void> {
  if (parserInitPromise) {
    await parserInitPromise;
    return;
  }
  parserInitPromise = Parser.init({
    locateFile(scriptName: string): string {
      if (scriptName.endsWith(".wasm")) return parserWasmPath();
      return scriptName;
    },
  });
  await parserInitPromise;
}

const langCache = new Map<string, Language>();

export async function loadLanguage(name: "typescript" | "tsx" | "python"): Promise<Language> {
  await initParser();
  const cached = langCache.get(name);
  if (cached) return cached;
  const wasmBytes = readFileSync(grammarWasmPath(name));
  const lang = await Language.load(wasmBytes);
  langCache.set(name, lang);
  return lang;
}

const queryCache = new Map<string, string>();

export function loadQuery(name: "typescript" | "python"): string {
  const cached = queryCache.get(name);
  if (cached) return cached;
  const path = join(here, "queries", `${name}.scm`);
  const src = readFileSync(path, "utf8");
  queryCache.set(name, src);
  return src;
}

/**
 * Compile-once cache for tree-sitter Query objects, keyed by grammar identity.
 * Compiling a query is expensive (~6ms per file at scale) and the result is
 * pure with respect to the grammar+source pair, so we cache aggressively.
 *
 * Keyed by Language object identity via WeakMap so reloaded grammars
 * (which produce a new Language instance) get a fresh compiled query.
 * Cached queries are NEVER deleted — callers must not call .delete() on them.
 */
const compiledQueryCache = new WeakMap<Language, Query>();

export function getCompiledQuery(
  grammar: Language,
  queryName: "typescript" | "python",
): Query {
  const cached = compiledQueryCache.get(grammar);
  if (cached) return cached;
  const src = loadQuery(queryName);
  // 0.26 removed Language#query — Query is now constructed directly.
  const q = new Query(grammar, src);
  compiledQueryCache.set(grammar, q);
  return q;
}

export function newParser(language: Language): Parser {
  const p = new Parser();
  p.setLanguage(language);
  return p;
}

export type { Parser, Language, Query };
