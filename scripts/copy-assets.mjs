// Copy non-TS assets that the bundle needs at runtime: tree-sitter queries
// (.scm) and a copy of the parser/grammar wasm files so the published `dist/`
// works inside `node:20` Docker without re-resolving from node_modules.
import { copyFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = dirname(new URL(import.meta.url).pathname);
const repoRoot = join(root, "..");

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function copyQueries() {
  const srcDir = join(repoRoot, "src", "graph", "parser", "queries");
  const dstDir = join(repoRoot, "dist", "graph", "parser", "queries");
  ensureDir(dstDir);
  for (const f of readdirSync(srcDir)) {
    if (f.endsWith(".scm")) {
      copyFileSync(join(srcDir, f), join(dstDir, f));
    }
  }
}

function copySchema() {
  const src = join(repoRoot, "src", "graph", "schema.sql");
  const dst = join(repoRoot, "dist", "graph", "schema.sql");
  ensureDir(dirname(dst));
  copyFileSync(src, dst);
}

function copyWasm() {
  const dstDir = join(repoRoot, "dist", "wasm");
  ensureDir(dstDir);

  const parserWasm = require.resolve("web-tree-sitter/tree-sitter.wasm");
  copyFileSync(parserWasm, join(dstDir, "tree-sitter.wasm"));

  const grammarsPkg = require.resolve("tree-sitter-wasms/package.json");
  const grammarsDir = join(dirname(grammarsPkg), "out");
  if (existsSync(grammarsDir)) {
    for (const name of ["typescript", "tsx", "python"]) {
      const file = `tree-sitter-${name}.wasm`;
      copyFileSync(join(grammarsDir, file), join(dstDir, file));
    }
  }
}

copyQueries();
copySchema();
copyWasm();
console.log("dist/ assets copied (queries, schema.sql, wasm)");
