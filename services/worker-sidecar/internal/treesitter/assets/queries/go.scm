;; Go AST Query
(package_clause
  (package_identifier) @package.name)

(function_declaration
  name: (identifier) @name) @definition.function

(method_declaration
  name: (field_identifier) @name) @definition.method

(type_spec
  name: (type_identifier) @name) @definition.type

(const_spec
  name: (identifier) @name) @definition.variable

(var_spec
  name: (identifier) @name) @definition.variable

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (selector_expression
    operand: (_) @call.operand
    field: (field_identifier) @name)) @reference.call

(import_spec
  path: [
    (interpreted_string_literal) @import.source
    (raw_string_literal) @import.source
  ]) @import

(import_spec
  name: [
    (package_identifier) @import.binding
    (blank_identifier) @import.blank
    (dot) @import.dot
  ])
