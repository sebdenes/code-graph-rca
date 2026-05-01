/**
 * Names that look like unresolved CALLS in the graph but are really stdlib
 * builtins, common collection methods, or framework primitives. Filtering
 * them keeps the ambiguity score honest — a function that calls `len` and
 * `isinstance` 30 times isn't a "dynamic dispatch surprise", it's just
 * Python.
 *
 * Conservative: anything whose true callee can't be statically known but is
 * clearly stdlib/runtime gets filtered. App-level names (even ambiguous
 * ones) stay in the list — those are the ones worth flagging.
 */
export const STDLIB_AND_BUILTIN_NAMES: ReadonlySet<string> = new Set([
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
  "dirname", "basename", "splitext",

  // JS / TS builtins (subset that show up as unresolved CALLS)
  "Array", "Object", "Number", "String", "Boolean", "Date", "Math",
  "JSON", "console", "Promise", "Symbol", "Error", "TypeError",
  "RangeError", "Map", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "queueMicrotask", "structuredClone",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI",

  // Common JS array/string methods
  "forEach", "then", "catch", "finally", "push", "shift", "unshift",
  "slice", "splice", "concat", "indexOf", "lastIndexOf", "includes",
  "reduce", "reduceRight", "flat", "flatMap", "entries", "fromEntries",
  "freeze", "assign", "create", "defineProperty", "getOwnPropertyNames",
  "getPrototypeOf", "setPrototypeOf", "is", "isExtensible", "isSealed",
  "isFrozen", "preventExtensions", "seal",
  "length", "toString", "valueOf", "hasOwnProperty",
  "propertyIsEnumerable", "bind", "apply", "call",
  "match", "matchAll", "search", "trim", "trimStart", "trimEnd",
  "padStart", "padEnd", "repeat", "normalize", "fromCharCode",
  "charAt", "charCodeAt", "codePointAt", "fromCodePoint",

  // Promise / async
  "resolve", "reject", "race", "any", "all",
]);

export function isStdlibName(name: string): boolean {
  return STDLIB_AND_BUILTIN_NAMES.has(name);
}
