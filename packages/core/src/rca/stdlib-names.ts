/**
 * Names that look like unresolved CALLS in the graph but are really stdlib
 * builtins, common collection methods, or framework primitives. Filtering
 * them keeps the ambiguity score honest — a function that calls `len` and
 * `isinstance` 30 times isn't a "dynamic dispatch surprise", it's just
 * Python.
 *
 * Conservative: anything whose true callee can't be statically known but is
 * clearly stdlib/runtime/test-framework/popular-lib (>=99% noise) gets
 * filtered. App-level names (even ambiguous ones) stay in the list — those
 * are the ones worth flagging.
 */
export const STDLIB_AND_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  // Python builtin exception classes (raise / except show as unresolved CALLS)
  "Exception", "BaseException", "RuntimeError", "ValueError", "TypeError",
  "KeyError", "IndexError", "AttributeError", "NameError", "OSError",
  "IOError", "FileNotFoundError", "FileExistsError", "PermissionError",
  "NotImplementedError", "StopIteration", "StopAsyncIteration",
  "GeneratorExit", "KeyboardInterrupt", "SystemExit", "ArithmeticError",
  "ZeroDivisionError", "OverflowError", "FloatingPointError",
  "AssertionError", "ImportError", "ModuleNotFoundError", "LookupError",
  "MemoryError", "RecursionError", "ReferenceError", "SyntaxError",
  "IndentationError", "TabError", "UnicodeError", "UnicodeDecodeError",
  "UnicodeEncodeError", "UnicodeTranslateError", "Warning",
  "DeprecationWarning", "FutureWarning", "UserWarning", "RuntimeWarning",
  "TimeoutError", "ConnectionError", "ConnectionRefusedError",
  "ConnectionResetError", "ConnectionAbortedError", "BrokenPipeError",
  "ChildProcessError", "BlockingIOError", "InterruptedError",
  "IsADirectoryError", "NotADirectoryError", "ProcessLookupError",

  // Python builtins
  "abs", "all", "any", "ascii", "bin", "bool", "bytearray", "bytes",
  "callable", "chr", "classmethod", "compile", "complex", "delattr",
  "dict", "dir", "divmod", "enumerate", "eval", "exec", "filter",
  "float", "format", "frozenset", "getattr", "globals", "hasattr",
  "hash", "help", "hex", "id", "input", "int", "isinstance",
  "issubclass", "iter", "len", "list", "locals", "map", "max",
  "memoryview", "min", "next", "object", "oct", "open", "ord", "pow",
  "print", "property", "range", "repr", "reversed", "round", "set",
  "setattr", "slice", "sorted", "staticmethod", "str", "sum", "super",
  "tuple", "type", "vars", "zip",

  // Common Python str/list/dict/set methods (look unresolved on x.method())
  "append", "extend", "insert", "pop", "remove", "clear", "copy",
  "count", "index", "sort", "reverse", "keys", "values", "items",
  "get", "setdefault", "update", "fromkeys", "add", "discard",
  "intersection", "union", "difference", "symmetric_difference",
  "issubset", "issuperset",
  "split", "rsplit", "splitlines", "join", "strip", "lstrip", "rstrip",
  "lower", "upper", "title", "capitalize", "casefold", "swapcase",
  "startswith", "endswith", "find", "rfind", "replace", "translate",
  "encode", "decode", "format_map", "zfill", "ljust", "rjust", "center",
  "isalnum", "isalpha", "isdigit", "isspace", "isupper", "islower",

  // datetime / time / json / common stdlib methods
  "now", "today", "utcnow", "fromtimestamp", "timestamp", "isoformat",
  "fromisoformat", "strftime", "strptime", "date", "time", "weekday",
  "isoweekday", "replace", "astimezone", "utctimetuple", "timetuple",
  "total_seconds", "timedelta",
  "dumps", "loads", "dump", "load",
  "read", "readline", "readlines", "write", "writelines", "close",
  "seek", "tell", "flush", "truncate",
  "read_text", "write_text", "read_bytes", "write_bytes",

  // statistics / math (common stdlib)
  "mean", "median", "mode", "stdev", "variance", "std", "sqrt", "ceil",
  "floor", "log", "log2", "log10", "exp", "sin", "cos", "tan", "atan",
  "atan2", "monotonic", "perf_counter", "process_time",

  // numpy / sklearn / pandas (popular libs — when methods come up unresolved)
  "array", "asarray", "zeros", "ones", "empty", "arange", "linspace",
  "reshape", "transpose", "dot", "matmul", "argmax", "argmin", "argsort",
  "cumsum", "cumprod", "ravel", "flatten", "squeeze", "expand_dims",
  "concatenate", "stack", "vstack", "hstack", "where", "clip",
  "fit", "transform", "fit_transform", "predict", "predict_proba",
  "score", "fit_predict", "inverse_transform", "partial_fit",
  "DataFrame", "Series", "read_csv", "read_json", "to_csv", "to_json",
  "to_dict", "to_numpy", "iloc", "loc", "groupby", "merge", "concat",

  // argparse
  "add_argument", "parse_args", "parse_known_args", "add_subparsers",
  "add_parser", "add_argument_group", "add_mutually_exclusive_group",
  "ArgumentParser", "Namespace",

  // random (stdlib)
  "uniform", "gauss", "randint", "choice", "choices", "shuffle", "seed",
  "sample", "randrange", "random", "betavariate", "expovariate",
  "gammavariate", "lognormvariate", "normalvariate", "paretovariate",
  "triangular", "vonmisesvariate", "weibullvariate", "getrandbits",

  // dataclasses / typing helpers
  "field", "fields", "asdict", "astuple", "make_dataclass", "is_dataclass",
  "dataclass", "InitVar", "MISSING",

  // types / sys / functools / itertools (common factory + helpers)
  "SimpleNamespace", "MappingProxyType", "ModuleType", "FunctionType",
  "MethodType", "BuiltinFunctionType", "GeneratorType", "CoroutineType",
  "AsyncGeneratorType", "TracebackType", "FrameType",
  "exit",
  "partial", "partialmethod", "reduce", "lru_cache", "cache",
  "cached_property", "wraps", "singledispatch", "singledispatchmethod",
  "chain", "cycle", "repeat", "starmap", "tee", "takewhile",
  "dropwhile", "groupby", "islice", "product", "permutations",
  "combinations", "combinations_with_replacement", "accumulate",
  "compress", "count", "filterfalse", "zip_longest",

  // collections
  "Counter", "OrderedDict", "defaultdict", "deque", "ChainMap",
  "namedtuple", "UserDict", "UserList", "UserString",

  // contextlib
  "contextmanager", "asynccontextmanager", "suppress", "ExitStack",
  "AsyncExitStack", "closing", "redirect_stdout", "redirect_stderr",
  "nullcontext",

  // re / regex
  "search", "match", "fullmatch", "sub", "subn", "compile", "escape",
  "findall", "finditer", "group", "groups", "groupdict", "span",

  // asyncio
  "gather", "sleep", "wait", "wait_for", "create_task", "ensure_future",
  "run", "to_thread", "run_in_executor", "as_completed", "shield",
  "current_task", "get_event_loop", "new_event_loop", "set_event_loop",

  // logging methods
  "debug", "info", "warning", "error", "critical", "exception", "log",

  // os / pathlib (instance method names)
  "exists", "is_file", "is_dir", "mkdir", "rmdir", "unlink", "rename",
  "stat", "iterdir", "glob", "rglob", "with_suffix", "with_name",
  "resolve", "absolute", "joinpath", "relative_to", "parent",
  "dirname", "basename", "splitext", "extname",

  // Python unittest.mock — these masquerade as unresolved calls in test files
  "MagicMock", "AsyncMock", "Mock", "NonCallableMock", "NonCallableMagicMock",
  "PropertyMock", "patch", "mock_open", "call", "ANY", "sentinel",
  "create_autospec", "seal",
  "assert_called", "assert_called_once", "assert_called_with",
  "assert_called_once_with", "assert_not_called", "assert_any_call",
  "assert_has_calls", "reset_mock", "configure_mock",

  // pytest fixture/test helpers
  "fixture", "raises", "warns", "approx", "skip", "xfail", "param",
  "parametrize", "mark", "monkeypatch", "tmp_path", "tmpdir", "capsys",
  "capfd", "caplog",

  // sqlite3 / DB-API cursor + connection methods (Python sqlite3, also
  // better-sqlite3 in Node which uses prepare/run/get/all)
  "execute", "executemany", "executescript", "fetchone", "fetchall",
  "fetchmany", "commit", "rollback", "cursor", "lastrowid", "rowcount",
  "prepare", "pluck", "expand", "raw", "columns",

  // SQLAlchemy ORM (common method names that show up unresolved)
  "query", "first", "one", "one_or_none", "scalar", "scalars",
  "flush", "merge", "expunge", "refresh", "bulk_insert_mappings",
  "bulk_save_objects", "with_entities", "options", "joinedload",
  "selectinload", "subqueryload", "outerjoin", "subquery", "exists",
  "distinct", "group_by", "order_by", "limit", "offset", "having",
  "where", "select_from", "from_statement",

  // Mongo / pymongo / motor
  "findOne", "find_one", "insertOne", "insert_one", "insertMany",
  "insert_many", "updateOne", "update_one", "updateMany", "update_many",
  "deleteOne", "delete_one", "deleteMany", "delete_many",
  "replaceOne", "replace_one", "findOneAndUpdate", "find_one_and_update",
  "findOneAndDelete", "find_one_and_delete", "findOneAndReplace",
  "find_one_and_replace", "bulkWrite", "bulk_write", "aggregate",
  "countDocuments", "count_documents", "createIndex", "create_index",
  "dropIndex", "drop_index", "distinct",

  // requests / httpx / urllib / aiohttp HTTP method names + clients
  "post", "put", "head", "options", "request", "send", "json",
  "Client", "AsyncClient", "Session", "Response", "Request",
  "TestClient", "URL",

  // FastAPI / Starlette response + dependency primitives
  "HTTPException", "JSONResponse", "HTMLResponse", "PlainTextResponse",
  "RedirectResponse", "FileResponse", "StreamingResponse", "Response",
  "Depends", "Body", "Form", "File", "UploadFile", "Header", "Cookie",
  "Security", "BackgroundTasks", "Query", "APIRouter",

  // datetime constructors (datetime.datetime(...), pathlib.Path(...))
  "datetime", "Path", "PurePath", "PurePosixPath", "PureWindowsPath",
  "PosixPath", "WindowsPath",

  // JS / TS builtins (subset that show up as unresolved CALLS)
  "Array", "Object", "Number", "String", "Boolean", "Date", "Math",
  "JSON", "console", "Promise", "Symbol", "Error", "TypeError",
  "RangeError", "Map", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect",
  "BigInt", "RegExp", "ArrayBuffer", "DataView",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array",
  "Uint16Array", "Int32Array", "Uint32Array", "Float32Array",
  "Float64Array", "BigInt64Array", "BigUint64Array",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "setImmediate", "clearImmediate",
  "queueMicrotask", "structuredClone",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI",

  // JS Array.prototype (full set)
  "forEach", "push", "pop", "shift", "unshift", "slice", "splice",
  "concat", "indexOf", "lastIndexOf", "includes", "find", "findIndex",
  "findLast", "findLastIndex", "filter", "reduce", "reduceRight",
  "some", "every", "sort", "reverse", "fill", "copyWithin",
  "flat", "flatMap", "entries", "at", "with",
  "toReversed", "toSorted", "toSpliced",
  "isArray", "of", "from",

  // JS String.prototype (full set)
  "substring", "substr", "charAt", "charCodeAt", "codePointAt",
  "matchAll", "replaceAll", "padStart", "padEnd", "repeat",
  "normalize", "trim", "trimStart", "trimEnd", "trimLeft", "trimRight",
  "toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase",
  "fromCharCode", "fromCodePoint",
  "startsWith", "endsWith",

  // JS Number.prototype
  "toFixed", "toExponential", "toPrecision", "toLocaleString",

  // Object static methods
  "fromEntries", "assign", "freeze", "create", "defineProperty",
  "defineProperties", "getOwnPropertyNames", "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors", "getOwnPropertySymbols",
  "getPrototypeOf", "setPrototypeOf", "is", "isExtensible", "isSealed",
  "isFrozen", "preventExtensions", "seal",

  // Function.prototype / common
  "length", "toString", "valueOf", "hasOwnProperty",
  "propertyIsEnumerable", "bind", "apply", "call",

  // Map / Set methods
  "has", "delete", "size",

  // Promise / async
  "then", "catch", "finally", "resolve", "reject", "race",
  "allSettled",

  // console (extra)
  "warn", "trace", "table", "groupEnd", "groupCollapsed", "time", "timeEnd",
  "timeLog", "assert", "dir", "dirxml", "profile", "profileEnd",

  // Node fs (sync + async)
  "existsSync", "readFileSync", "writeFileSync", "appendFileSync",
  "statSync", "lstatSync", "fstatSync", "mkdirSync", "rmSync",
  "rmdirSync", "unlinkSync", "readdirSync", "realpathSync", "accessSync",
  "copyFileSync", "chmodSync", "chownSync", "truncateSync",
  "readlinkSync", "symlinkSync", "linkSync", "renameSync", "utimesSync",
  "createReadStream", "createWriteStream",
  "readFile", "writeFile", "appendFile", "readdir", "rm",

  // Node child_process
  "spawnSync", "spawn", "execSync", "execFileSync", "execFile", "fork",

  // Node os / process / globals
  "cwd", "chdir", "homedir", "tmpdir", "platform", "arch", "hostname",
  "userInfo", "uptime", "loadavg", "totalmem", "freemem", "cpus",
  "networkInterfaces", "endianness", "release",
  "mkdtempSync", "mkdtemp",
  "fetch",

  // fs.Stats methods
  "isDirectory", "isFile", "isSymbolicLink", "isBlockDevice",
  "isCharacterDevice", "isFIFO", "isSocket",

  // React hooks (popular-lib, ~100% noise when seen as unresolved calls)
  "useState", "useEffect", "useRef", "useMemo", "useCallback",
  "useContext", "useReducer", "useLayoutEffect", "useImperativeHandle",
  "useDebugValue", "useId", "useTransition", "useDeferredValue",
  "useSyncExternalStore", "useInsertionEffect",

  // Node path (already have dirname/basename)
  "relative", "isAbsolute", "normalize", "parse",

  // DOM (very common in TS/JS codebases)
  "appendChild", "removeChild", "createElement", "createTextNode",
  "createDocumentFragment", "addEventListener", "removeEventListener",
  "dispatchEvent", "querySelector", "querySelectorAll",
  "getElementById", "getElementsByClassName", "getElementsByTagName",
  "getElementsByName", "setAttribute", "getAttribute", "removeAttribute",
  "hasAttribute", "classList", "focus", "blur", "click", "submit",

  // Canvas 2D (lineTo, moveTo, etc. show up as unresolved calls)
  "lineTo", "moveTo", "beginPath", "closePath", "stroke", "arc",
  "arcTo", "bezierCurveTo", "quadraticCurveTo", "rect", "fillRect",
  "clearRect", "strokeRect", "drawImage", "fillText", "strokeText",
  "measureText", "save", "restore", "translate", "rotate", "scale",
  "transform", "setTransform", "resetTransform", "getImageData",
  "putImageData", "createImageData", "createLinearGradient",
  "createRadialGradient", "createPattern",

  // JSON (capitalized) static methods get caught by `JSON` constructor entry
  // but specific methods worth listing
  "stringify", "parse",
]);

export function isStdlibName(name: string): boolean {
  return STDLIB_AND_BUILTIN_NAMES.has(name);
}
