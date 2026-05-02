; Python tree-sitter queries for code-graph RCA.
;
; Capture name conventions (consumed by the extractor):
;   Symbols:
;     @symbol.function   top-level function definition
;     @symbol.method     function definition inside a class body
;     @symbol.class      class definition
;     @symbol.name       identifier for the symbol
;     @symbol.parent     enclosing class name for methods
;   Edges:
;     @call.callee       identifier callee, or attribute name on attribute call
;     @call.object       receiver object of an attribute call
;     @extends.target    base class identifier in `class A(B):`
;   Imports:
;     @import.named      `from m import x` — the imported name
;     @import.namespace  `import m as ns` namespace alias target
;     @import.alias      local alias (`as` name) in either form
;     @import.source     module path (dotted name; relative imports keep the
;                        leading dots in the source text the extractor reads)
;
; Decorated definitions: @decorated_definition wraps either a function_definition
; or a class_definition. The inner definition still matches its own pattern, so
; captures pass through naturally — no separate decorated patterns are required.

; ---------------- Symbols ----------------

; Top-level function (any function_definition not inside a class block will be
; emitted with @symbol.function; the more-specific method pattern below ALSO
; fires for methods, and the extractor prefers the @symbol.method capture when
; both are present on the same node).
(function_definition
  name: (identifier) @symbol.name) @symbol.function

; Method: function_definition that lives directly inside a class block.
(class_definition
  name: (identifier) @symbol.parent
  body: (block
    (function_definition
      name: (identifier) @symbol.name) @symbol.method))

; Method wrapped in a decorator inside a class block.
(class_definition
  name: (identifier) @symbol.parent
  body: (block
    (decorated_definition
      definition: (function_definition
        name: (identifier) @symbol.name) @symbol.method)))

; Class definition — no superclasses
(class_definition
  name: (identifier) @symbol.name) @symbol.class

; Class with base classes: capture each base identifier as @extends.target.
(class_definition
  superclasses: (argument_list
    (identifier) @extends.target))

; Class with attribute base (e.g. `class A(mod.Base):`): capture the trailing
; attribute name; the extractor can resolve qualifiers from source text.
(class_definition
  superclasses: (argument_list
    (attribute
      attribute: (identifier) @extends.target)))

; ---------------- Locals ----------------
; Capture every assignment — no anchor. The extractor walks ancestors to find
; the nearest enclosing function_definition; if none exists (module-level)
; the assignment is dropped. tuple_pattern / list_pattern targets are
; expanded by the extractor: it walks into the `left` field and emits one
; local per identifier. Annotated forms (`x: int = 1`) parse as `assignment`
; with a `type` field alongside `left` + `right`; the same capture handles
; both. Comprehension targets live inside (list_comprehension|dict_comprehension|
; set_comprehension|generator_expression) — those don't contain `assignment`
; so they're naturally excluded.

(assignment) @symbol.localdecl

; Loop iteration variables (`for k, v in d.items():`). The extractor reads
; the `left` field and emits one local per identifier (handling tuple
; unpacking the same way as assignment).

(for_statement) @symbol.loopvar

; ---------------- Calls ----------------

; Direct identifier call: foo(...)
(call
  function: (identifier) @call.callee)

; Attribute call: obj.method(...) — object → @call.object, attr → @call.callee.
(call
  function: (attribute
    object: (identifier) @call.object
    attribute: (identifier) @call.callee))

; Nested attribute call: a.b.c(...) — still capture the immediate attribute as
; callee; record the closest attribute name as the object so the extractor has
; a usable receiver hint.
(call
  function: (attribute
    object: (attribute
      attribute: (identifier) @call.object)
    attribute: (identifier) @call.callee))

; ---------------- Imports ----------------

; import m
(import_statement
  name: (dotted_name) @import.source)

; import m as n   (aliased_import inside import_statement)
(import_statement
  name: (aliased_import
    name: (dotted_name) @import.source
    alias: (identifier) @import.alias)) @import.namespace

; from m import x
(import_from_statement
  module_name: (dotted_name) @import.source
  name: (dotted_name) @import.named)

; from m import x as y
(import_from_statement
  module_name: (dotted_name) @import.source
  name: (aliased_import
    name: (dotted_name) @import.named
    alias: (identifier) @import.alias))

; from .pkg import x  — relative_import as module_name; the extractor reads
; the source text to recover leading dots and the (optional) trailing path.
(import_from_statement
  module_name: (relative_import) @import.source
  name: (dotted_name) @import.named)

(import_from_statement
  module_name: (relative_import) @import.source
  name: (aliased_import
    name: (dotted_name) @import.named
    alias: (identifier) @import.alias))

; from m import *  — wildcard token has no identifier child; the extractor
; sees @import.source with no @import.named/@import.alias siblings on the
; same statement and treats it as a star import.
(import_from_statement
  module_name: (dotted_name) @import.source
  (wildcard_import))

(import_from_statement
  module_name: (relative_import) @import.source
  (wildcard_import))
