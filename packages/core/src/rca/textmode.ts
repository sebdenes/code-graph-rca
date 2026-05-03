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
 * Decompose a compound identifier into its sub-words for cross-style matching.
 *
 * Rules:
 * - Split on `_` (snake_case → ["send", "message", "safe"])
 * - Split at lowercase→uppercase boundaries (camelCase → ["send", "Message"])
 * - Keep digit runs as their own piece (`v2Foo` → ["v2", "Foo"])
 * - Lowercase every sub-word so they match both styles uniformly
 * - Drop sub-words of length < 3 (`is`, `to`, `id` → too noisy)
 *
 * Returns the decomposed pieces (NOT the original — caller adds the original
 * separately if it wants both). Empty list for tokens that decompose to noise.
 *
 * Examples:
 *   "sendMessage"        → ["send", "message"]
 *   "send_message_safe"  → ["send", "message", "safe"]
 *   "_strip_markdown"    → ["strip", "markdown"]
 *   "fetch_planned_events" → ["fetch", "planned", "events"]
 *   "Login"              → ["login"]
 *   "id"                 → []   (too short)
 */
export function splitCompound(token: string): string[] {
  if (!token) return [];
  // Step 1: split on _ → handles snake_case and leading/trailing underscores.
  // Step 2: each piece, split on lowercase→uppercase OR letter→digit boundaries.
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of token.split("_")) {
    if (!piece) continue;
    // Insert a space at boundaries we want to split on, then split on space.
    const spaced = piece
      .replace(/([a-z])([A-Z])/g, "$1 $2")        // camelCase boundary
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")   // ALL-CAPS → Title (ABCThing → ABC Thing)
      .replace(/([A-Za-z])(\d)/g, "$1 $2")        // letter→digit
      .replace(/(\d)([A-Za-z])/g, "$1 $2");       // digit→letter
    for (const sub of spaced.split(/\s+/)) {
      const lc = sub.toLowerCase();
      if (lc.length < 3) continue;
      if (STOPWORDS.has(lc)) continue;
      if (seen.has(lc)) continue;
      seen.add(lc);
      out.push(lc);
    }
  }
  return out;
}

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
    /** Sub-word substring hits against s.name (camelCase ↔ snake_case bridge). */
    subnameSet: Set<string>;
    /** Token hits against s.signature (literals + identifier sub-words ≥5 chars). */
    bodySet: Set<string>;
    /** v7: token hits against s.body_preview (identifier sub-words ≥6 chars only). */
    bodyContentSet: Set<string>;
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
        subnameSet: new Set<string>(),
        bodySet: new Set<string>(),
        bodyContentSet: new Set<string>(),
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

  // 1a. EXACT NAME-MATCH: symbols.name = ? (case-sensitive). Highest weight.
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

  // 1b. SUBSTRING NAME-MATCH (case-insensitive): builds the camelCase ↔
  //     snake_case bridge that pure exact match misses. We decompose each
  //     identifier token into its sub-words ("sendMessage" → ["send",
  //     "message"]) and substring-match LOWER(s.name) against each piece
  //     of length >= 4 (3-char pieces like "set"/"get"/"add" match too
  //     much). Smaller weight than exact match — this is recall sugar,
  //     not the primary signal.
  //
  //     Bound runaway: cap rows per substring to 100. Symbols with name
  //     length >= 5 are eligible (so `i` doesn't hit `i_path`).
  const subNameStmt = db.prepare(
    // ORDER BY length(name) DESC — longer names are more specific signal.
    // Without this, a sub-word like "sport" matching 200+ symbols (the eval corpus
    // 2026-05-03) returns the first-100-by-id and drops specific candidates
    // like `_parse_sport_setting_cp` (22 chars, in late-walked file)
    // entirely. The a type-coercion bug miss traced directly to this LIMIT.
    `SELECT s.id AS id, s.name AS name, f.path AS path, s.start_line AS start_line
       FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE LOWER(s.name) LIKE ? ESCAPE '\\'
        AND length(s.name) >= 5
      ORDER BY length(s.name) DESC
      LIMIT 100`,
  );
  const seenSubName = new Set<string>();
  const tryNameSubstring = (sub: string): void => {
    if (sub.length < 4) return;
    if (seenSubName.has(sub)) return;
    seenSubName.add(sub);
    const escaped = sub.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = subNameStmt.all(`%${escaped}%`) as SymRow[];
    for (const r of rows) {
      const a = ensure(r.id, r.name, r.path, r.start_line);
      // Only count if the sub-word didn't already land via exact match
      // (avoid double-counting). Tracked under the original token bucket.
      a.subnameSet.add(sub);
    }
  };
  for (const tok of tokens.identifierTokens) {
    for (const sub of splitCompound(tok)) tryNameSubstring(sub);
    // Also try the lowercased original — bridges `Login` → `login` etc.
    tryNameSubstring(tok.toLowerCase());
  }

  // 2a. LITERAL → SIGNATURE only (high precision). Literals like `"marathon"`
  //     in default-value signatures are strong signal. We DON'T search
  //     body_preview for literals here because short literals like `"10k"`
  //     or `"v2"` blow up to thousands of body hits with terrible precision.
  const sigStmt = db.prepare(
    `SELECT s.id AS id, s.name AS name, f.path AS path, s.start_line AS start_line
       FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE s.signature LIKE ? ESCAPE '\\'`,
  );
  for (const tok of tokens.literalTokens) {
    const escaped = tok.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = sigStmt.all(`%${escaped}%`) as SymRow[];
    for (const r of rows) {
      const a = ensure(r.id, r.name, r.path, r.start_line);
      a.bodySet.add(tok);
    }
  }

  // 2b. IDENTIFIER SUB-WORD → SIGNATURE: identifiers often appear in type
  //     hints / default values. Length >= 5 to avoid noise.
  const seenSigSub = new Set<string>();
  const trySignatureSubstring = (sub: string, originalTok: string): void => {
    if (sub.length < 5) return;
    const key = sub + "\0" + originalTok;
    if (seenSigSub.has(key)) return;
    seenSigSub.add(key);
    const escaped = sub.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = sigStmt.all(`%${escaped}%`) as SymRow[];
    for (const r of rows) {
      const a = ensure(r.id, r.name, r.path, r.start_line);
      a.bodySet.add(originalTok);
    }
  };
  for (const tok of tokens.identifierTokens) {
    if (tok.length >= 5) trySignatureSubstring(tok.toLowerCase(), tok);
    for (const sub of splitCompound(tok)) trySignatureSubstring(sub, tok);
  }

  // 2c. v7: BODY-CONTENT match. Search prose tokens against function bodies
  //     (the first ~30 lines captured at index time as `body_preview`).
  //     Lower weight than name/signature: body matches are recall sugar for
  //     cases where the failure description references implementation-detail
  //     words (e.g. "asterisks" in pr22 maps to `re.sub(r'[*_~`]', ...)` in
  //     `_strip_markdown`'s body but NOT its name or signature).
  //
  //     **Length guard tuned empirically (the eval corpus 2026-05-03)**: only tokens
  //     of length >= 8 search the body. Shorter tokens ("error", "fetch",
  //     "events", "marathon", "scheduler") are common enough in code bodies
  //     that they displace real top-1s (cyclist + events + compliance all
  //     dropped to miss when length>=6 was used at weight=0.6). Length >= 8
  //     leaves only "asterisks", "Markdown", "transient", "telegram"-class
  //     tokens — specific enough to stay precision-positive.
  const bodyContentStmt = db.prepare(
    `SELECT s.id AS id, s.name AS name, f.path AS path, s.start_line AS start_line
       FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE s.body_preview LIKE ? ESCAPE '\\'
        AND s.body_preview IS NOT NULL`,
  );
  const seenBodySub = new Set<string>();
  const tryBodyContent = (sub: string, originalTok: string): void => {
    if (sub.length < 8) return;
    const key = sub + "\0" + originalTok;
    if (seenBodySub.has(key)) return;
    seenBodySub.add(key);
    const escaped = sub.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = bodyContentStmt.all(`%${escaped}%`) as SymRow[];
    for (const r of rows) {
      const a = ensure(r.id, r.name, r.path, r.start_line);
      a.bodyContentSet.add(originalTok);
    }
  };
  for (const tok of tokens.identifierTokens) {
    if (tok.length >= 8) tryBodyContent(tok.toLowerCase(), tok);
    for (const sub of splitCompound(tok)) tryBodyContent(sub, tok);
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

  // Score + normalize. Weight ordering:
  //   exact name (3.0) > signature (2.0) > substring name (1.0) >
  //   body content (0.6) > import (0.5)
  // Body-content weight is intentionally below substring-name: it's recall
  // sugar that surfaces "asterisks" → `_strip_markdown` (pr22), but body
  // tokens are inherently noisier than name tokens — many functions have
  // bodies that mention common words. Lower weight prevents body matches
  // from displacing real name/signature hits.
  const NAME_W = 3.0;
  const SUBNAME_W = 1.0;
  const BODY_W = 2.0;
  const BODY_CONTENT_W = 0.3;
  const IMPORT_W = 0.5;
  // Max ceiling: every identifier token AND every sub-word can fire on every
  // bucket. We cap sub-word count at 3 per token (typical decomposition) so
  // long failure descriptions don't push the ceiling unrealistically high.
  const SUBWORDS_PER_TOK = 3;
  const maxRaw =
    NAME_W * tokens.identifierTokens.length +
    SUBNAME_W * tokens.identifierTokens.length * SUBWORDS_PER_TOK +
    BODY_W * tokens.literalTokens.length +
    BODY_W * tokens.identifierTokens.length +
    BODY_CONTENT_W * tokens.identifierTokens.length +
    IMPORT_W * tokens.identifierTokens.length;

  const out: TokenMatch[] = [];
  for (const [id, a] of acc) {
    const nameMatches = a.nameSet.size;
    const subnameMatches = a.subnameSet.size;
    const bodyMatches = a.bodySet.size;
    const bodyContentMatches = a.bodyContentSet.size;
    const importMatches = a.importSet.size;
    const raw =
      NAME_W * nameMatches +
      SUBNAME_W * subnameMatches +
      BODY_W * bodyMatches +
      BODY_CONTENT_W * bodyContentMatches +
      IMPORT_W * importMatches;
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
