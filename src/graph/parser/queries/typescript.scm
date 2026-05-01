; TypeScript / TSX tree-sitter queries for code-graph RCA.
;
; Capture name conventions (consumed by the extractor):
;   Symbols:
;     @symbol.function   top-level function declaration
;     @symbol.method     method inside a class body
;     @symbol.class      class declaration
;     @symbol.interface  TS interface declaration
;     @symbol.const      top-level const/let bound to arrow/function expression
;     @symbol.enum       TS enum declaration
;     @symbol.type       TS type alias declaration
;     @symbol.name       the identifier of the symbol
;     @symbol.parent     enclosing class name for methods
;     @symbol.exported   outer export_statement marker (presence => exported)
;   Edges:
;     @call.callee       identifier or property of a call expression
;     @call.object       receiver of a member-expression call
;     @extends.target    base class identifier
;     @implements.target implemented interface identifier
;   Imports:
;     @import.named      named import binding
;     @import.default    default import binding
;     @import.namespace  `* as ns` import binding
;     @import.alias      local alias name in `{ x as y }`
;     @import.source     module specifier string

; ---------------- Symbols ----------------

; Top-level function declaration
(function_declaration
  name: (identifier) @symbol.name) @symbol.function

; Class declaration (with optional extends + implements captured)
(class_declaration
  name: (type_identifier) @symbol.name) @symbol.class

(class_declaration
  (class_heritage
    (extends_clause
      value: (identifier) @extends.target)))

(class_declaration
  (class_heritage
    (extends_clause
      value: (member_expression
        property: (property_identifier) @extends.target))))

(class_declaration
  (class_heritage
    (implements_clause
      (type_identifier) @implements.target)))

; Methods inside a class body — capture parent class name as @symbol.parent
(class_declaration
  name: (type_identifier) @symbol.parent
  body: (class_body
    (method_definition
      name: (property_identifier) @symbol.name) @symbol.method))

; Interface declaration
(interface_declaration
  name: (type_identifier) @symbol.name) @symbol.interface

; Enum declaration
(enum_declaration
  name: (identifier) @symbol.name) @symbol.enum

; Type alias declaration
(type_alias_declaration
  name: (type_identifier) @symbol.name) @symbol.type

; Top-level const/let with arrow-function or function-expression initializer.
; lexical_declaration → variable_declarator(name, value)
(lexical_declaration
  (variable_declarator
    name: (identifier) @symbol.name
    value: (arrow_function))) @symbol.const

(lexical_declaration
  (variable_declarator
    name: (identifier) @symbol.name
    value: (function_expression))) @symbol.const

; ---------------- Exported wrappers ----------------
; A separate set of patterns that fires only when the declaration is wrapped in
; an `export_statement`. The outer node carries @symbol.exported; the inner
; capture re-exposes the symbol kind so the extractor can correlate.

(export_statement
  (function_declaration
    name: (identifier) @symbol.name) @symbol.function) @symbol.exported

(export_statement
  (class_declaration
    name: (type_identifier) @symbol.name) @symbol.class) @symbol.exported

(export_statement
  (interface_declaration
    name: (type_identifier) @symbol.name) @symbol.interface) @symbol.exported

(export_statement
  (enum_declaration
    name: (identifier) @symbol.name) @symbol.enum) @symbol.exported

(export_statement
  (type_alias_declaration
    name: (type_identifier) @symbol.name) @symbol.type) @symbol.exported

(export_statement
  (lexical_declaration
    (variable_declarator
      name: (identifier) @symbol.name
      value: (arrow_function))) @symbol.const) @symbol.exported

(export_statement
  (lexical_declaration
    (variable_declarator
      name: (identifier) @symbol.name
      value: (function_expression))) @symbol.const) @symbol.exported

; ---------------- Calls ----------------

; Direct identifier callee: foo()
(call_expression
  function: (identifier) @call.callee)

; Member-expression callee: foo.bar() — capture both object and property.
(call_expression
  function: (member_expression
    object: (identifier) @call.object
    property: (property_identifier) @call.callee))

; Chained / nested member call: a.b.c() — still capture the immediate property
; as the callee; the object is the immediate receiver expression's identifier
; if available (for deeper chains the extractor can fall back to source text).
(call_expression
  function: (member_expression
    object: (member_expression
      property: (property_identifier) @call.object)
    property: (property_identifier) @call.callee))

; ---------------- Imports ----------------
; import_statement → import_clause → (named_imports | namespace_import | identifier)
; source: (string)

; Named imports: import { a, b as c } from "m"
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @import.named)))
  source: (string) @import.source)

; Named imports with alias: { x as y }
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @import.named
        alias: (identifier) @import.alias)))
  source: (string) @import.source)

; Default import: import Foo from "m"
(import_statement
  (import_clause
    (identifier) @import.default)
  source: (string) @import.source)

; Namespace import: import * as ns from "m"
(import_statement
  (import_clause
    (namespace_import
      (identifier) @import.namespace))
  source: (string) @import.source)
