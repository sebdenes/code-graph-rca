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
  "symbol.local": "local",
};

/**
 * Identifier-like node types whose `text` is the name of a single binding.
 * Used by `collectBindingNames` to decide what to emit as a local symbol.
 * Tree-sitter exposes shorthand_property_identifier_pattern for `{a, b}`
 * destructuring shorthands; identifier covers normal cases plus the renamed
 * side of `{a: renamed}`. property_identifier appears as the LHS of pair_pattern
 * (the original property name); we deliberately skip it — the local introduced
 * is the renamed identifier, not the source property.
 */
const BINDING_IDENTIFIER_TYPES = new Set([
  "identifier",
  "shorthand_property_identifier_pattern",
]);

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

    // 1a) Local declaration (lexical_declaration / variable_declaration / assignment)
    // — may emit zero or many `kind='local'` symbols depending on the LHS pattern.
    const localdeclCap = idx.byCapture.get("symbol.localdecl")?.[0];
    if (localdeclCap) {
      processLocalDeclaration(
        localdeclCap.node,
        symbolsByKey,
        grammar,
      );
      continue;
    }

    // 1b) Loop iteration variable (for_in_statement / for_statement TS,
    // for_statement Python). May emit zero or many locals (tuple unpacking).
    const loopvarCap = idx.byCapture.get("symbol.loopvar")?.[0];
    if (loopvarCap) {
      processLoopVarDeclaration(
        loopvarCap.node,
        symbolsByKey,
        grammar,
      );
      continue;
    }

    // 1) Symbol-defining match
    const primary = pickPrimarySymbolCapture(idx);
    if (primary) {
      const innerNode = primary.cap.node;
      const nameCap = idx.byCapture.get("symbol.name")?.[0];
      if (!nameCap) continue;
      const name = captureText(nameCap);
      let parentName: string | null = null;
      let startLine = innerNode.startPosition.row + 1;
      let endLine = innerNode.endPosition.row + 1;
      let signature: string | null = firstSignatureLine(innerNode);
      if (primary.kind === "local") {
        // Local var: parent is the enclosing function-shaped node, located
        // by walking up from the captured declaration. We deliberately don't
        // use a @symbol.parent capture here because tree-sitter's capture
        // mechanics make it awkward to surface the enclosing function name
        // through a query that anchors on the body — walking the ancestor
        // chain is one hop and unambiguous. end_line stretches to the
        // enclosing function's end so resolveArgBindingSources can scope a
        // local to its declaring function. signature is the declaration's
        // first line, trimmed.
        const enclosing = findEnclosingFunctionNode(innerNode);
        if (!enclosing) continue;
        parentName = enclosingFunctionName(enclosing);
        if (!parentName) continue;
        endLine = enclosing.endPosition.row + 1;
      } else {
        const parentCap = idx.byCapture.get("symbol.parent")?.[0];
        parentName = parentCap ? captureText(parentCap) : null;
      }
      const exported = idx.byCapture.has("symbol.exported");
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
          signature,
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

/**
 * Walk up from a captured local declaration to its enclosing function-shaped
 * node (function_declaration, function_expression, arrow_function,
 * method_definition, function_definition for Python). Returns null if no such
 * ancestor exists within a small bounded number of hops.
 */
function findEnclosingFunctionNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  // Bounded walk capped at 64 hops — deeply nested if/while/try blocks can
  // push the function ancestor several levels up, but real code rarely
  // exceeds a depth of 10. Cap exists to defend against pathological trees.
  for (let i = 0; i < 64 && cur; i++) {
    switch (cur.type) {
      case "function_declaration":
      case "function_expression":
      case "arrow_function":
      case "method_definition":
      case "function_definition":
        return cur;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Read the name of an enclosing function-shaped node. For arrow_function and
 * function_expression we walk one more level: those typically appear as the
 * value of a variable_declarator or pair, so the name is the declarator's
 * identifier. Returns null when no name can be recovered (anonymous IIFEs
 * etc. — those locals are dropped because they have no addressable parent).
 */
function enclosingFunctionName(node: Parser.SyntaxNode): string | null {
  const directName = node.childForFieldName("name");
  if (directName) return directName.text;
  // Anonymous: arrow / function expression assigned somewhere. Walk up one
  // level and look for a variable_declarator's name field.
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type === "variable_declarator" || parent.type === "assignment") {
    const n = parent.childForFieldName("name") ?? parent.childForFieldName("left");
    if (n && (n.type === "identifier" || n.type === "property_identifier")) {
      return n.text;
    }
  }
  return null;
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
  // `symbol.local` is no longer driven by queries (locals come through the
  // localdecl/loopvar paths now); it stays in SYMBOL_CAPTURES only for the
  // ExtractedSymbol kind enum mapping.
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

/**
 * Process a captured `lexical_declaration` / `variable_declaration` (TS) or
 * `assignment` (Python) node and emit one kind='local' symbol per binding name
 * on the LHS. Skips:
 *   - declarations not nested inside any function-shaped node (module-level
 *     consts are already captured by the dedicated @symbol.const patterns);
 *   - declarations whose nearest function ancestor is anonymous AND not bound
 *     to a named declarator (anonymous IIFEs — no addressable parent);
 *   - subscript/attribute assignments (Python `obj.x = 1`, `arr[0] = 1`) —
 *     these don't introduce new locals;
 *   - destructured names beyond the binding identifiers (e.g. property keys
 *     in `{a: renamed}` emit `renamed`, not `a`).
 *
 * Tree-sitter naturally skips comprehensions in Python (their `for in` lives
 * inside list_comprehension etc., not block) and class/object bodies in TS
 * (those don't host lexical_declaration). We DO descend into nested lexical
 * declarations across if/while/for blocks but we stop at function boundaries
 * — a nested function declaration's locals belong to it, not its enclosing
 * function.
 */
function processLocalDeclaration(
  declNode: Parser.SyntaxNode,
  symbolsByKey: Map<string, SymbolWithRange>,
  grammar: "typescript" | "tsx" | "python",
): void {
  // Find the nearest function-shaped ancestor. If none → module-level
  // declaration, skip (covered by other @symbol.* patterns where applicable).
  const enclosing = findEnclosingFunctionNode(declNode);
  if (!enclosing) return;
  // Defensive: if the path from declNode to enclosing crosses a *closer*
  // function-shaped node, that closer one is actually the parent. The
  // ancestor walk in findEnclosingFunctionNode already returns the nearest,
  // so this is implicit — no extra check needed.
  const parentName = enclosingFunctionName(enclosing);
  if (!parentName) return;
  const endLine = enclosing.endPosition.row + 1;

  // Collect all binding identifier nodes from the LHS of the declaration.
  // For TS: walk each variable_declarator's name field.
  // For Python: walk the assignment's left field (skip subscript/attribute).
  const names: Parser.SyntaxNode[] = [];
  if (grammar === "python") {
    const left = declNode.childForFieldName("left");
    if (!left) return;
    // Subscript/attribute targets are not locals; skip.
    if (left.type === "subscript" || left.type === "attribute") return;
    collectBindingNames(left, names);
  } else {
    for (let i = 0; i < declNode.namedChildCount; i++) {
      const declarator = declNode.namedChild(i);
      if (!declarator || declarator.type !== "variable_declarator") continue;
      const name = declarator.childForFieldName("name");
      if (!name) continue;
      collectBindingNames(name, names);
    }
  }

  for (const nameNode of names) {
    emitLocal(nameNode, declNode, parentName, endLine, symbolsByKey);
  }
}

/**
 * Process a captured `for_in_statement` / `for_statement` (TS) or
 * `for_statement` (Python) and emit one kind='local' per identifier in the
 * iterator binding. Scope: technically loop-only, but we attach to the
 * enclosing function — false-positive rate is negligible since loop vars
 * rarely shadow other locals, and the resolver's BFS walks symbols whose
 * parent_id is the caller anyway.
 */
function processLoopVarDeclaration(
  loopNode: Parser.SyntaxNode,
  symbolsByKey: Map<string, SymbolWithRange>,
  grammar: "typescript" | "tsx" | "python",
): void {
  const enclosing = findEnclosingFunctionNode(loopNode);
  if (!enclosing) return;
  const parentName = enclosingFunctionName(enclosing);
  if (!parentName) return;
  const endLine = enclosing.endPosition.row + 1;

  const names: Parser.SyntaxNode[] = [];
  if (grammar === "python") {
    // for_statement.left is identifier | pattern_list | tuple_pattern
    const left = loopNode.childForFieldName("left");
    if (!left) return;
    collectBindingNames(left, names);
  } else if (loopNode.type === "for_in_statement") {
    // for_in_statement.left is identifier | object_pattern | array_pattern
    const left = loopNode.childForFieldName("left");
    if (!left) return;
    collectBindingNames(left, names);
  } else if (loopNode.type === "for_statement") {
    // C-style: initializer is a lexical_declaration (or expression_statement
    // for `for (i = 0; ...)`). Reuse the lexical-declaration walker.
    const initializer = loopNode.childForFieldName("initializer");
    if (!initializer) return;
    if (
      initializer.type === "lexical_declaration" ||
      initializer.type === "variable_declaration"
    ) {
      for (let i = 0; i < initializer.namedChildCount; i++) {
        const declarator = initializer.namedChild(i);
        if (!declarator || declarator.type !== "variable_declarator") continue;
        const name = declarator.childForFieldName("name");
        if (!name) continue;
        collectBindingNames(name, names);
      }
    }
  }

  for (const nameNode of names) {
    emitLocal(nameNode, loopNode, parentName, endLine, symbolsByKey);
  }
}

/**
 * Recursively walk a binding pattern, pushing every binding-identifier node
 * onto `out`. Handles object_pattern (`{a, b: c, ...rest}`), array_pattern
 * (`[x, y, ...rest]`), pair_pattern (the renamed-side identifier), rest_pattern,
 * tuple_pattern (Python), pattern_list (Python), list_pattern (Python).
 *
 * Skips nested function bodies (defensive — destructuring patterns shouldn't
 * contain functions, but if some grammar quirk surfaces an arrow_function
 * default value we don't want to dive into it). Skips assignment_pattern
 * defaults' RHS for the same reason: the LHS of `{a = 1}` is what binds.
 */
function collectBindingNames(
  node: Parser.SyntaxNode,
  out: Parser.SyntaxNode[],
): void {
  if (BINDING_IDENTIFIER_TYPES.has(node.type)) {
    out.push(node);
    return;
  }
  switch (node.type) {
    case "object_pattern":
    case "array_pattern":
    case "tuple_pattern":
    case "list_pattern":
    case "pattern_list":
    case "rest_pattern":
    case "list_splat_pattern":
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) collectBindingNames(child, out);
      }
      return;
    case "pair_pattern": {
      // pair_pattern: key (property_identifier) : value (identifier|pattern).
      // The local binding is the *value* side.
      const value = node.childForFieldName("value");
      if (value) collectBindingNames(value, out);
      return;
    }
    case "assignment_pattern": {
      // {a = 1} — the LHS is the binding.
      const left = node.childForFieldName("left") ?? node.namedChild(0);
      if (left) collectBindingNames(left, out);
      return;
    }
    case "object_assignment_pattern": {
      // TS sometimes wraps shorthand-with-default: {a = 1}.
      const left = node.childForFieldName("left") ?? node.namedChild(0);
      if (left) collectBindingNames(left, out);
      return;
    }
    default:
      // Unknown / non-binding node — skip silently. property_identifier
      // (the key side of pair_pattern) lands here and is correctly ignored.
      return;
  }
}

/**
 * Build a SymbolWithRange for a single local binding and stash it under a
 * deduping key. Multiple captures of the same declaration (e.g. an outer
 * statement-block match overlapping a function-anchored match in the legacy
 * patterns) collapse to one symbol per (parentName, name, declStart, nameStart).
 * The nameStart is included so destructured siblings (`const {a, b} = x`)
 * get distinct keys.
 */
function emitLocal(
  nameNode: Parser.SyntaxNode,
  declNode: Parser.SyntaxNode,
  parentName: string,
  endLine: number,
  symbolsByKey: Map<string, SymbolWithRange>,
): void {
  const name = nameNode.text;
  if (!name || name.length === 0) return;
  // Skip Python's _ throwaway and similar — they're noise for resolution.
  if (name === "_") return;
  const startLine = declNode.startPosition.row + 1;
  const signature = firstSignatureLine(declNode);
  const key = `local:${name}:${parentName}:${declNode.startIndex}:${nameNode.startIndex}`;
  if (symbolsByKey.has(key)) return;
  symbolsByKey.set(key, {
    name,
    kind: "local",
    parentName,
    startLine,
    endLine,
    signature,
    exported: false,
    startIndex: nameNode.startIndex,
    endIndex: nameNode.endIndex,
  });
}
