import Parser from "web-tree-sitter";
import { getCompiledQuery, loadLanguage, newParser } from "./loader.js";
import type {
  ArgSourceKind,
  ExtractedArgBinding,
  ExtractedEdge,
  ExtractedFile,
  ExtractedImport,
  ExtractedParam,
  ExtractedSymbol,
  ExtractedSymbolParams,
  Language,
  SymbolKind,
} from "../../types.js";

const SYMBOL_CAPTURES: Record<string, SymbolKind> = {
  "symbol.function": "function",
  "symbol.method": "method",
  "symbol.class": "class",
  "symbol.interface": "interface",
  "symbol.const": "const",
  "symbol.enum": "enum",
  "symbol.type": "type",
};

interface SymbolWithRange extends ExtractedSymbol {
  startIndex: number;
  endIndex: number;
}

function pickGrammar(relPath: string): "typescript" | "tsx" | "python" | null {
  const lower = relPath.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) return "tsx";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "typescript";
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python";
  return null;
}

function queryNameForGrammar(g: "typescript" | "tsx" | "python"): "typescript" | "python" {
  return g === "python" ? "python" : "typescript";
}

function languageForGrammar(g: "typescript" | "tsx" | "python"): Language {
  return g === "python" ? "python" : "typescript";
}

function captureText(cap: Parser.QueryCapture): string {
  return cap.text ?? cap.node.text;
}

function firstSignatureLine(node: Parser.SyntaxNode): string {
  const text = node.text;
  const newline = text.indexOf("\n");
  return (newline < 0 ? text : text.slice(0, newline)).trim().slice(0, 200);
}

interface RawMatch {
  byCapture: Map<string, Parser.QueryCapture[]>;
}

function indexCaptures(match: Parser.QueryMatch): RawMatch {
  const byCapture = new Map<string, Parser.QueryCapture[]>();
  for (const cap of match.captures) {
    const list = byCapture.get(cap.name);
    if (list) list.push(cap);
    else byCapture.set(cap.name, [cap]);
  }
  return { byCapture };
}

export async function extractFile(opts: {
  relPath: string;
  source: string;
}): Promise<ExtractedFile | null> {
  const grammar = pickGrammar(opts.relPath);
  if (grammar === null) {
    return {
      path: opts.relPath,
      language: "unparsed",
      loc: countLoc(opts.source),
      symbols: [],
      edges: [],
      imports: [],
    };
  }

  const lang = await loadLanguage(grammar);
  const parser = newParser(lang);
  const tree = parser.parse(opts.source);
  const query = getCompiledQuery(lang, queryNameForGrammar(grammar));
  const matches = query.matches(tree.rootNode);

  const symbolsByKey = new Map<string, SymbolWithRange>();
  const pendingEdges: Array<{
    fromNode: Parser.SyntaxNode;
    toName: string;
    toReceiverName: string | null;
    kind: ExtractedEdge["kind"];
    confidence: number;
    callLine: number;
    argBindings?: ExtractedArgBinding[];
  }> = [];
  const imports: ExtractedImport[] = [];
  // Param captures keyed by start index of the formal_parameters node so we
  // can attach them to the smallest enclosing function/method/const symbol
  // after symbol extraction. TS only — Python query intentionally omits these.
  const paramCaptures: Array<{ node: Parser.SyntaxNode; startIndex: number }> =
    grammar === "python" ? [] : [];

  for (const match of matches) {
    const idx = indexCaptures(match);

    // 1) Symbol-defining match
    const primary = pickPrimarySymbolCapture(idx);
    if (primary) {
      const innerNode = primary.cap.node;
      const nameCap = idx.byCapture.get("symbol.name")?.[0];
      if (!nameCap) continue;
      const name = captureText(nameCap);
      const parentCap = idx.byCapture.get("symbol.parent")?.[0];
      const parentName = parentCap ? captureText(parentCap) : null;
      const exported = idx.byCapture.has("symbol.exported");
      const startLine = innerNode.startPosition.row + 1;
      const endLine = innerNode.endPosition.row + 1;
      const key = `${primary.kind}:${name}:${parentName ?? ""}:${innerNode.startIndex}`;
      const existing = symbolsByKey.get(key);
      if (existing) {
        if (exported) existing.exported = true;
      } else {
        symbolsByKey.set(key, {
          name,
          kind: primary.kind,
          parentName,
          startLine,
          endLine,
          signature: firstSignatureLine(innerNode),
          exported,
          startIndex: innerNode.startIndex,
          endIndex: innerNode.endIndex,
        });
      }
      continue;
    }

    // 2) Call edge
    const calleeCap = idx.byCapture.get("call.callee")?.[0];
    if (calleeCap) {
      const objCap = idx.byCapture.get("call.object")?.[0];
      // Walk up to the enclosing call_expression to read its arguments node.
      // For TS, that's at most a couple of hops (callee → call_expression, or
      // callee → member_expression → call_expression).
      const callExpr = grammar === "python" ? null : findCallExpression(calleeCap.node);
      const argBindings: ExtractedArgBinding[] =
        callExpr ? extractArgBindings(callExpr) : [];
      pendingEdges.push({
        fromNode: calleeCap.node,
        toName: captureText(calleeCap),
        toReceiverName: objCap ? captureText(objCap) : null,
        kind: "CALLS",
        confidence: 1.0,
        callLine: calleeCap.node.startPosition.row + 1,
        argBindings,
      });
      continue;
    }

    // 2b) Formal parameters node — TS only.
    if (grammar !== "python") {
      const paramsCap = idx.byCapture.get("symbol.params")?.[0];
      if (paramsCap) {
        paramCaptures.push({
          node: paramsCap.node,
          startIndex: paramsCap.node.startIndex,
        });
        continue;
      }
    }

    // 3) Extends / implements
    const extendsCap = idx.byCapture.get("extends.target")?.[0];
    if (extendsCap) {
      pendingEdges.push({
        fromNode: extendsCap.node,
        toName: captureText(extendsCap),
        toReceiverName: null,
        kind: "EXTENDS",
        confidence: 1.0,
        callLine: extendsCap.node.startPosition.row + 1,
      });
      continue;
    }
    const implCap = idx.byCapture.get("implements.target")?.[0];
    if (implCap) {
      pendingEdges.push({
        fromNode: implCap.node,
        toName: captureText(implCap),
        toReceiverName: null,
        kind: "IMPLEMENTS",
        confidence: 1.0,
        callLine: implCap.node.startPosition.row + 1,
      });
      continue;
    }

    // 4) Import
    const sourceCap = idx.byCapture.get("import.source")?.[0];
    if (sourceCap) {
      const sourceText = stripQuotes(captureText(sourceCap));
      const named = idx.byCapture.get("import.named")?.[0];
      const def = idx.byCapture.get("import.default")?.[0];
      const ns = idx.byCapture.get("import.namespace")?.[0];
      const alias = idx.byCapture.get("import.alias")?.[0];
      if (named) {
        const sourceName = captureText(named);
        const localName = alias ? captureText(alias) : sourceName;
        imports.push({
          localName,
          sourceModule: sourceText,
          sourceName,
          kind: grammar === "python" ? "from" : "named",
        });
      } else if (def) {
        imports.push({
          localName: captureText(def),
          sourceModule: sourceText,
          sourceName: "default",
          kind: "default",
        });
      } else if (ns) {
        const localName = grammar === "python" ? (alias ? captureText(alias) : sourceText) : captureText(ns);
        imports.push({
          localName,
          sourceModule: sourceText,
          sourceName: "*",
          kind: "namespace",
        });
      }
    }
  }

  const symbols = [...symbolsByKey.values()];
  const edges = resolveLocalEdges(symbols, pendingEdges);

  const out: ExtractedFile = {
    path: opts.relPath,
    language: languageForGrammar(grammar),
    loc: countLoc(opts.source),
    symbols: symbols.map(stripRange),
    edges,
    imports,
  };
  if (grammar !== "python") {
    out.symbolParams = attachParamsToSymbols(symbols, paramCaptures);
  }

  tree.delete();
  // query is cached at module level; do not delete.
  parser.delete();
  return out;
}

/** Walk up from a callee identifier/property to its enclosing call_expression. */
function findCallExpression(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  // At most 3 hops: identifier → member_expression → member_expression → call_expression.
  for (let i = 0; i < 4 && cur; i++) {
    if (cur.type === "call_expression") return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Walk the `arguments` child of a call_expression and classify each top-level
 * argument expression. We deliberately don't recurse — `foo(bar(x))` records
 * one `call`-kind binding for `bar(x)`, not two; the inner call gets its own
 * `arg_bindings` row via its own pendingEdge.
 */
function extractArgBindings(callExpr: Parser.SyntaxNode): ExtractedArgBinding[] {
  const argsNode = callExpr.childForFieldName("arguments");
  if (!argsNode) return [];
  const out: ExtractedArgBinding[] = [];
  let position = 0;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const child = argsNode.namedChild(i);
    if (!child) continue;
    if (child.type === "comment") continue;
    out.push({
      position,
      sourceKind: classifyArgKind(child.type),
      sourceText: child.text.slice(0, 200),
    });
    position++;
  }
  return out;
}

function classifyArgKind(nodeType: string): ArgSourceKind {
  switch (nodeType) {
    case "identifier":
    case "shorthand_property_identifier":
    case "this":
      return "identifier";
    case "string":
    case "number":
    case "true":
    case "false":
    case "null":
    case "undefined":
    case "template_string":
    case "regex":
      return "literal";
    case "member_expression":
    case "subscript_expression":
      return "member";
    case "call_expression":
    case "new_expression":
      return "call";
    case "spread_element":
      return "spread";
    default:
      return "other";
  }
}

/**
 * For each captured `formal_parameters` node, find the smallest enclosing
 * symbol (function/method/const) and record its parameter list. Binding by
 * range — same strategy used to attach call edges to their enclosing symbol.
 */
function attachParamsToSymbols(
  symbols: SymbolWithRange[],
  paramCaptures: Array<{ node: Parser.SyntaxNode; startIndex: number }>,
): ExtractedSymbolParams[] {
  if (paramCaptures.length === 0) return [];
  const sorted = symbols
    .slice()
    .sort((a, b) => a.endIndex - a.startIndex - (b.endIndex - b.startIndex));
  const out: ExtractedSymbolParams[] = [];
  // Dedupe per (kind, parentName, name) — multiple symbol matches for the
  // same declaration (e.g. exported wrapper) collapse to one params row.
  const seen = new Set<string>();
  for (const cap of paramCaptures) {
    let owner: SymbolWithRange | null = null;
    for (const s of sorted) {
      if (
        s.startIndex <= cap.startIndex &&
        cap.startIndex <= s.endIndex &&
        (s.kind === "function" || s.kind === "method" || s.kind === "const")
      ) {
        owner = s;
        break;
      }
    }
    if (!owner) continue;
    const key = `${owner.kind}:${owner.parentName ?? ""}:${owner.name}:${owner.startIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const params = parseFormalParameters(cap.node);
    out.push({
      ownerKind: owner.kind,
      ownerName: owner.name,
      ownerParentName: owner.parentName,
      params,
    });
  }
  return out;
}

function parseFormalParameters(node: Parser.SyntaxNode): ExtractedParam[] {
  const out: ExtractedParam[] = [];
  let position = 0;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const kind = child.type;
    if (
      kind !== "required_parameter" &&
      kind !== "optional_parameter" &&
      kind !== "rest_pattern" &&
      kind !== "rest_parameter"
    ) {
      continue;
    }
    const patternNode =
      child.childForFieldName("pattern") ?? child.namedChild(0);
    const name = patternNode ? patternNode.text.slice(0, 100) : "";
    if (!name) {
      position++;
      continue;
    }
    const typeNode = child.childForFieldName("type");
    // type field on TS yields `type_annotation`, whose text starts with ": ".
    let typeText: string | null = null;
    if (typeNode) {
      const raw = typeNode.text.trim();
      typeText = raw.startsWith(":") ? raw.slice(1).trim() : raw;
      if (typeText.length > 200) typeText = typeText.slice(0, 200);
      if (typeText.length === 0) typeText = null;
    }
    const valueNode = child.childForFieldName("value");
    const hasDefault = valueNode !== null || kind === "optional_parameter";
    out.push({ position, name, typeText, hasDefault });
    position++;
  }
  return out;
}

function pickPrimarySymbolCapture(idx: RawMatch): {
  cap: Parser.QueryCapture;
  kind: SymbolKind;
} | null {
  // Prefer @symbol.method over @symbol.function when both fire on the same node.
  const ordered = [
    "symbol.method",
    "symbol.function",
    "symbol.class",
    "symbol.interface",
    "symbol.const",
    "symbol.enum",
    "symbol.type",
  ];
  for (const name of ordered) {
    const cap = idx.byCapture.get(name)?.[0];
    if (cap) {
      const kind = SYMBOL_CAPTURES[name];
      if (kind) return { cap, kind };
    }
  }
  return null;
}

function resolveLocalEdges(
  symbols: SymbolWithRange[],
  pending: Array<{
    fromNode: Parser.SyntaxNode;
    toName: string;
    toReceiverName: string | null;
    kind: ExtractedEdge["kind"];
    confidence: number;
    callLine: number;
    argBindings?: ExtractedArgBinding[];
  }>,
): ExtractedEdge[] {
  // Sort symbols ascending by range size so the smallest-containing symbol
  // wins when we scan for an enclosing function/method/class.
  const sorted = symbols.slice().sort((a, b) => a.endIndex - a.startIndex - (b.endIndex - b.startIndex));
  const out: ExtractedEdge[] = [];
  for (const e of pending) {
    const fromIndex = e.fromNode.startIndex;
    let enclosing: SymbolWithRange | null = null;
    for (const s of sorted) {
      if (s.startIndex <= fromIndex && fromIndex <= s.endIndex) {
        if (s.kind === "function" || s.kind === "method" || s.kind === "const" || s.kind === "class") {
          enclosing = s;
          break;
        }
      }
    }
    if (!enclosing) continue;
    const edge: ExtractedEdge = {
      fromName: enclosing.name,
      fromParentName: enclosing.parentName,
      toName: e.toName,
      toReceiverName: e.toReceiverName,
      kind: e.kind,
      confidence: e.confidence,
      callLine: e.callLine,
    };
    if (e.argBindings && e.argBindings.length > 0) {
      edge.argBindings = e.argBindings;
    }
    out.push(edge);
  }
  return out;
}

function stripRange(s: SymbolWithRange): ExtractedSymbol {
  return {
    name: s.name,
    kind: s.kind,
    parentName: s.parentName,
    startLine: s.startLine,
    endLine: s.endLine,
    signature: s.signature,
    exported: s.exported,
  };
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' || a === "'" || a === "`") && a === b) return s.slice(1, -1);
  }
  return s;
}

function countLoc(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
