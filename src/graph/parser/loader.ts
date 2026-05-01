import Parser from "web-tree-sitter";
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
    const p = join(bundled, "tree-sitter.wasm");
    if (existsSync(p)) return p;
  }
  const pkgPath = requireFromHere.resolve("web-tree-sitter/package.json");
  return join(dirname(pkgPath), "tree-sitter.wasm");
}

function grammarWasmPath(name: string): string {
  const bundled = bundledWasmDir();
  if (bundled) {
    const p = join(bundled, `tree-sitter-${name}.wasm`);
    if (existsSync(p)) return p;
  }
  const pkgPath = requireFromHere.resolve("tree-sitter-wasms/package.json");
  return join(dirname(pkgPath), "out", `tree-sitter-${name}.wasm`);
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

const langCache = new Map<string, Parser.Language>();

export async function loadLanguage(name: "typescript" | "tsx" | "python"): Promise<Parser.Language> {
  await initParser();
  const cached = langCache.get(name);
  if (cached) return cached;
  const wasmBytes = readFileSync(grammarWasmPath(name));
  const lang = await Parser.Language.load(wasmBytes);
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

export function newParser(language: Parser.Language): Parser {
  const p = new Parser();
  p.setLanguage(language);
  return p;
}

export type { Parser };
