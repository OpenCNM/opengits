;; Go AST Query
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
  function: [
    (identifier) @name
    (selector_expression field: (field_identifier) @name)
  ]) @reference.call

(import_spec
  path: (interpreted_string_literal) @import.source) @import
