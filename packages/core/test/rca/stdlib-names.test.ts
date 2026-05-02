import { describe, it, expect } from "vitest";
import {
  STDLIB_AND_BUILTIN_NAMES,
  isStdlibName,
} from "../../src/rca/stdlib-names.js";

/**
 * Names that the KG reviewer measured as the worst leaks through the
 * pre-expansion filter. These are the regression-protection set: if any of
 * them stops being filtered, phantom rate jumps back up on real codebases.
 */
const REGRESSION_NAMES = {
  // Python unittest.mock — top leak in real-world Python repos (MagicMock 2060, AsyncMock 1102)
  pythonMocks: [
    "MagicMock",
    "AsyncMock",
    "Mock",
    "patch",
    "mock_open",
    "call",
    "ANY",
    "sentinel",
    "assert_called_once",
    "assert_called_once_with",
    "assert_called_with",
    "assert_called",
    "assert_not_called",
    "assert_any_call",
    "assert_has_calls",
  ],

  // sqlite3 / DB-API + better-sqlite3 — `execute` was 1160 hits in real-world Python repos,
  // `prepare` was 51 hits in cgrca
  dbCursor: [
    "execute",
    "executemany",
    "executescript",
    "fetchone",
    "fetchall",
    "fetchmany",
    "commit",
    "rollback",
    "prepare",
  ],

  // SQLAlchemy ORM
  sqlalchemy: [
    "query",
    "first",
    "one_or_none",
    "scalar",
    "flush",
    "merge",
    "joinedload",
    "selectinload",
  ],

  // Mongo / pymongo
  mongo: [
    "findOne",
    "find_one",
    "insertOne",
    "insertMany",
    "updateOne",
    "deleteOne",
    "aggregate",
    "bulk_write",
    "find_one_and_update",
  ],

  // JS Array.prototype — `push` was 194 hits in cgrca pre-fix
  jsArray: [
    "push",
    "pop",
    "shift",
    "unshift",
    "slice",
    "splice",
    "concat",
    "indexOf",
    "lastIndexOf",
    "includes",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "forEach",
    "map",
    "filter",
    "reduce",
    "reduceRight",
    "some",
    "every",
    "sort",
    "reverse",
    "fill",
    "copyWithin",
    "flat",
    "flatMap",
    "keys",
    "values",
    "entries",
    "at",
  ],

  // JS String.prototype
  jsString: [
    "slice",
    "substring",
    "substr",
    "charAt",
    "charCodeAt",
    "codePointAt",
    "concat",
    "includes",
    "indexOf",
    "lastIndexOf",
    "match",
    "matchAll",
    "replace",
    "replaceAll",
    "search",
    "split",
    "startsWith",
    "endsWith",
    "padStart",
    "padEnd",
    "repeat",
    "normalize",
    "trim",
    "trimStart",
    "trimEnd",
    "toLowerCase",
    "toUpperCase",
    "toLocaleLowerCase",
    "toLocaleUpperCase",
  ],

  // JS Promise
  jsPromise: [
    "then",
    "catch",
    "finally",
    "all",
    "allSettled",
    "any",
    "race",
    "resolve",
    "reject",
  ],

  // JS Object static
  jsObject: [
    "keys",
    "values",
    "entries",
    "fromEntries",
    "assign",
    "freeze",
    "isFrozen",
    "seal",
    "create",
    "defineProperty",
    "getPrototypeOf",
    "setPrototypeOf",
  ],

  // JS Map / Set
  jsMapSet: ["set", "get", "has", "delete", "clear", "size", "forEach"],

  // Node fs (cgrca top leaks: existsSync 38, readFileSync 19, etc.)
  nodeFs: [
    "existsSync",
    "readFileSync",
    "writeFileSync",
    "statSync",
    "mkdirSync",
    "rmSync",
    "unlinkSync",
    "readdirSync",
    "lstatSync",
    "mkdtempSync",
    "createReadStream",
    "createWriteStream",
  ],

  // Node child_process (cgrca: spawnSync 24)
  nodeChildProc: ["spawnSync", "spawn", "execSync", "execFileSync", "fork"],

  // React hooks (cgrca: useState 24, useEffect 21, useRef 14)
  reactHooks: [
    "useState",
    "useEffect",
    "useRef",
    "useMemo",
    "useCallback",
    "useContext",
    "useReducer",
    "useLayoutEffect",
  ],

  // Python builtin exception classes
  pythonExceptions: [
    "Exception",
    "RuntimeError",
    "ValueError",
    "TypeError",
    "KeyError",
    "IndexError",
    "AttributeError",
    "FileNotFoundError",
    "NotImplementedError",
    "TimeoutError",
  ],
};

describe("stdlib-names", () => {
  describe("regression set (real-world top leaks)", () => {
    for (const [group, names] of Object.entries(REGRESSION_NAMES)) {
      for (const n of names) {
        it(`filters ${group}: ${n}`, () => {
          expect(isStdlibName(n)).toBe(true);
        });
      }
    }
  });

  describe("does NOT filter app-level names", () => {
    // These should remain unfiltered so the KG reviewer can flag them as
    // genuine ambiguity / import-resolution gaps.
    const appNames = [
      "get_state",
      "set_state",
      "handle_message",
      "build_session_details",
      "registerTool",
      "useSession", // next-auth — third-party hook, NOT stdlib
      "useQuery", // react-query — third-party hook, NOT stdlib
    ];
    for (const n of appNames) {
      it(`does not filter ${n}`, () => {
        expect(isStdlibName(n)).toBe(false);
      });
    }
  });

  describe("synthetic edge fixture", () => {
    // Fake unresolved CALLS edges as if pulled from `edges` table.
    type Edge = { to_name: string; to_symbol_id: number | null };
    const edges: Edge[] = [
      { to_name: "MagicMock", to_symbol_id: null },
      { to_name: "AsyncMock", to_symbol_id: null },
      { to_name: "execute", to_symbol_id: null },
      { to_name: "push", to_symbol_id: null },
      { to_name: "join", to_symbol_id: null },
      { to_name: "useState", to_symbol_id: null },
      { to_name: "existsSync", to_symbol_id: null },
      { to_name: "readFileSync", to_symbol_id: null },
      // app-level — should NOT be filtered
      { to_name: "myCustomHandler", to_symbol_id: null },
      { to_name: "build_session_details", to_symbol_id: null },
    ];

    it("filters all stdlib leaks but preserves app-level names", () => {
      const phantom = edges.filter(
        (e) => e.to_symbol_id === null && !isStdlibName(e.to_name),
      );
      expect(phantom.map((e) => e.to_name).sort()).toEqual([
        "build_session_details",
        "myCustomHandler",
      ]);
    });
  });

  it("set membership is consistent with isStdlibName helper", () => {
    for (const n of STDLIB_AND_BUILTIN_NAMES) {
      expect(isStdlibName(n)).toBe(true);
    }
  });
});
