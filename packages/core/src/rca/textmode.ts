import type { Db } from "../graph/db.js";

/**
 * Free-text retrieval (Phase 1, v0.5).
 *
 * Pre-Phase 1 the only failure shapes cgrca accepted were `symbol:NAME`,
 * `file:PATH`, `test:PATH`, or a path to a file containing stack-trace lines.
 * Anything that didn't match (prose description, intent statement, partial
 * trace pasted as-is) collapsed to the legacy "treat unknown spec as a
 * symbol name" branch which then returned 0 candidates.
 *
 * This module is the unblocker: tokenize the prose, look the tokens up in
 * the indexed knowledge graph (symbols, signatures, imports), and surface
 * the top matches as anchor seeds for the existing causal scorer. It is a
 * pure function of the request + Db — no I/O, no shell-out — so the runner
 * can call it inside the indexed-scope try/finally.
 */

/** A failure tokenized into the buckets the matcher cares about. */
export interface TokenizedFailure {
  /**
   * Identifier-shaped tokens (snake_case + camelCase + plain words),
   * length >= 3, English stopwords removed, deduped (case preserved —
   * we match symbols.name case-sensitively).
   */
  identifierTokens: string[];
  /**
   * Tokens lifted from inside `"..."` or `'...'`. Length >= 2 (short
   * literals like `"10k"` carry signal). Stopwords NOT removed —
   * a literal stopword inside quotes was deliberate ("the marathon").
   */
  literalTokens: string[];
  /** Original input, unmodified. Useful for downstream rationale. */
  bodyText: string;
}

/** A single symbol that some subset of failure tokens hit. */
export interface TokenMatch {
  symbolId: number;
  symbolName: string;
  file: string | null;
  line: number | null;
  /** Distinct identifier tokens that matched symbol.name exactly. */
  nameMatches: number;
  /**
   * Distinct literal tokens that matched `symbols.signature` via SQL LIKE.
   * NOTE: signature only stores the first declaration line today — full
   * body matching would need the API-layer `sliceBody` helper. See
   * the limitation comment near `matchTokensAgainstKg`.
   */
  bodyMatches: number;
  /** Distinct identifier tokens that matched an `imports.local_name` in the same file. */
  importMatches: number;
  /**
   * Weighted sum normalized to [0,1]. weights: name=3, body=2, import=0.5.
   * Normalization: divide by max-possible (every token hits every bucket),
   * so totalScore=1.0 means every name/body/import token landed.
   */
  totalScore: number;
}

const STOPWORDS = new Set<string>([
  "the", "a", "an", "is", "was", "are", "were", "when", "then", "this",
  "that", "for", "with", "and", "or", "but", "not", "no", "yes", "as",
  "at", "by", "in", "on", "of", "to", "from", "it", "its", "be", "been",
  "being", "has", "have", "had", "can", "could", "should", "would",
  "will", "does", "did", "do", "one", "two", "three", "which", "what",
  "why", "how", "where", "who", "about", "after", "before", "because",
]);

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Lift quoted substrings (single or double quote) out of `text`. Returns
 * the stripped tokens (no quote chars) and the input with the quoted
 * regions blanked out so the identifier pass doesn't re-tokenize the
 * quote contents as bare identifiers.
 *
 * We deliberately accept literals as short as 2 characters — `"10k"`,
 * `"v2"`, `"id"` are common gold-signal payloads in error messages and a
 * 3-char minimum would silently drop them.
 */
function extractLiterals(text: string): { literals: string[]; rest: string } {
  const literals: string[] = [];
  // Replace each quoted region with same-length spaces so column offsets
  // (and any future rationale that wants them) line up with the original.
  const rest = text.replace(
    /(["'])((?:\\.|(?!\1)[^\\])*)\1/g,
    (_full, _quote, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed.length >= 2) literals.push(trimmed);
      return " ".repeat(_full.length);
    },
  );
  return { literals, rest };
}

/**
 * Tokenize a free-text failure description into the buckets the KG matcher
 * uses. Pure function — no I/O, deterministic ordering.
 *
 * Tokenizer rules (must stay in lock-step with the comment in v0.5-plan.md):
 * - Quoted strings (`"..."` / `'...'`) become literal tokens, length >= 2.
 * - Everything else: split on non-identifier chars, keep `[A-Za-z_]\w*` of
 *   length >= 3, drop English stopwords (case-insensitive comparison).
 * - Dedupe both lists while preserving first-seen order. We preserve case
 *   on the identifier tokens because the SQL `WHERE symbols.name = ?`
 *   match is case-sensitive — `Login` and `login` are different symbols.
 */
export function tokenizeFailure(input: string): TokenizedFailure {
  const bodyText = input;
  const { literals, rest } = extractLiterals(input);

  const seenIdent = new Set<string>();
  const identifierTokens: string[] = [];
  const matches = rest.match(IDENT_RE) ?? [];
  for (const m of matches) {
    if (m.length < 3) continue;
    if (STOPWORDS.has(m.toLowerCase())) continue;
    if (seenIdent.has(m)) continue;
    seenIdent.add(m);
    identifierTokens.push(m);
  }

  const seenLit = new Set<string>();
  const literalTokens: string[] = [];
  for (const l of literals) {
    if (seenLit.has(l)) continue;
    seenLit.add(l);
    literalTokens.push(l);
  }

  return { identifierTokens, literalTokens, bodyText };
}

/**
 * Run each token against the indexed KG and return a ranked list of
 * symbol matches. The three signals are designed to be cheap (one
 * prepared statement reused per token) and additive — every match earns
 * at least one weighted point so callers downstream can take the top-K
 * as anchor seeds for the existing causal scorer.
 *
 * **Limitation (Phase 1)**: body matching runs against `symbols.signature`,
 * which currently stores only the first declaration line. Full-body
 * search would need either a new `body_preview` column or a per-call
 * `sliceBody` invocation against the source files (which the API layer
 * already does — see `bodyPreview` work in the MCP server). For prose
 * failures, signature matches still catch parameter/type-hint payloads
 * (e.g. `or "marathon"` tokens land in default-value text). Phase 1
 * keeps the simpler "signatures-only" path; revisit if eval shows the
 * miss rate is dominated by body-only matches.
 */
export function matchTokensAgainstKg(
  db: Db,
  tokens: TokenizedFailure,
): TokenMatch[] {
  const allTokens = [...tokens.identifierTokens, ...tokens.literalTokens];
  if (allTokens.length === 0) return [];

  // Bucket per symbol id. We accumulate sets (distinct tokens) rather
  // than counters so a single token doesn't get to inflate its own bucket
  // by appearing twice in the prose.
  interface Acc {
    name: string;
    file: string | null;
    line: number | null;
    nameSet: Set<string>;
    bodySet: Set<string>;
    importSet: Set<string>;
  }
  const acc = new Map<number, Acc>();
  const ensure = (
    id: number,
    name: string,
    file: string | null,
    line: number | null,
  ): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = {
        name,
        file,
        line,
        nameSet: new Set<string>(),
        bodySet: new Set<string>(),
        importSet: new Set<string>(),
      };
      acc.set(id, a);
    }
    return a;
  };

  interface SymRow {
    id: number;
    name: string;
    path: string | null;
    start_line: number;
  }

  // 1. NAME-MATCH: symbols.name = ? (exact, case-sensitive). Only the
  //    identifier-shaped tokens are eligible — running a literal like
  //    "marathon" through this branch is fine but would never match a
  //    real symbol called `marathon` more often than the literal already
  //    did via the signature pass, and we'd double-count.
  const nameStmt = db.prepare(
    `SELECT s.id AS id, s.name AS name, f.path AS path, s.start_line AS start_line
       FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE s.name = ?`,
  );
  for (const tok of tokens.identifierTokens) {
    const rows = nameStmt.all(tok) as SymRow[];
    for (const r of rows) {
      const a = ensure(r.id, r.name, r.path, r.start_line);
      a.nameSet.add(tok);
    }
  }

  // 2. BODY-MATCH: symbols.signature LIKE '%token%'. Restricted to
  //    LITERAL tokens — these are the high-precision payloads (e.g.
  //    a misspelled string constant) and matching every identifier
  //    token against every signature blows up to O(N*M) with terrible
  //    precision (`session` would fire on every signature mentioning
  //    a Session typed param).
  const bodyStmt = db.prepare(
    `SELECT s.id AS id, s.name AS name, f.path AS path, s.start_line AS start_line
       FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE s.signature LIKE ? ESCAPE '\\'`,
  );
  for (const tok of tokens.literalTokens) {
    // Escape SQL LIKE wildcards in the user-supplied literal so a token
    // like `100%` doesn't match every signature. We use backslash as
    // the LIKE escape (declared on the prepared statement above).
    const escaped = tok.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = bodyStmt.all(`%${escaped}%`) as SymRow[];
    for (const r of rows) {
      const a = ensure(r.id, r.name, r.path, r.start_line);
      a.bodySet.add(tok);
    }
  }

  // 3. IMPORT-MATCH: imports.local_name = ?. We promote every symbol in
  //    the matching file (because an import being mentioned in the prose
  //    is evidence about *the file*, not a specific symbol). This is
  //    deliberately a weak signal — weight=0.5 — so it functions as a
  //    tiebreaker rather than driving the ranking on its own.
  const importStmt = db.prepare(
    `SELECT file_id, local_name FROM imports WHERE local_name = ?`,
  );
  const symsInFileStmt = db.prepare(
    `SELECT s.id AS id, s.name AS name, f.path AS path, s.start_line AS start_line
       FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE s.file_id = ?
        AND s.kind IN ('function','method','class','const','interface','type','enum')`,
  );
  // Cache file -> symbols so repeated import hits don't re-query.
  const fileSymsCache = new Map<number, SymRow[]>();
  const symsForFile = (fid: number): SymRow[] => {
    let cached = fileSymsCache.get(fid);
    if (!cached) {
      cached = symsInFileStmt.all(fid) as SymRow[];
      fileSymsCache.set(fid, cached);
    }
    return cached;
  };
  for (const tok of tokens.identifierTokens) {
    const importRows = importStmt.all(tok) as Array<{
      file_id: number;
      local_name: string;
    }>;
    for (const ir of importRows) {
      for (const sym of symsForFile(ir.file_id)) {
        const a = ensure(sym.id, sym.name, sym.path, sym.start_line);
        a.importSet.add(tok);
      }
    }
  }

  // Score + normalize. Max possible score per symbol is when every
  // token hits every bucket: nameW * |idTokens| + bodyW * |litTokens|
  // + importW * |idTokens|. We normalize by that ceiling so totalScore
  // is always in [0, 1] and doesn't blow up on long failure descriptions.
  const NAME_W = 3.0;
  const BODY_W = 2.0;
  const IMPORT_W = 0.5;
  const maxRaw =
    NAME_W * tokens.identifierTokens.length +
    BODY_W * tokens.literalTokens.length +
    IMPORT_W * tokens.identifierTokens.length;

  const out: TokenMatch[] = [];
  for (const [id, a] of acc) {
    const nameMatches = a.nameSet.size;
    const bodyMatches = a.bodySet.size;
    const importMatches = a.importSet.size;
    const raw =
      NAME_W * nameMatches + BODY_W * bodyMatches + IMPORT_W * importMatches;
    const totalScore = maxRaw > 0 ? raw / maxRaw : 0;
    if (raw === 0) continue;
    out.push({
      symbolId: id,
      symbolName: a.name,
      file: a.file,
      line: a.line,
      nameMatches,
      bodyMatches,
      importMatches,
      totalScore,
    });
  }

  // Stable sort: score DESC, then name ASC, then file ASC. Determinism
  // matters because seeds[0..K] is the anchor short-list and tests pin
  // its first few entries.
  out.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    if (a.symbolName !== b.symbolName)
      return a.symbolName < b.symbolName ? -1 : 1;
    const af = a.file ?? "";
    const bf = b.file ?? "";
    if (af !== bf) return af < bf ? -1 : 1;
    return a.symbolId - b.symbolId;
  });
  return out;
}
