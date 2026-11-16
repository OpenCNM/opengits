;; Zig AST Query
(function_declaration
  name: (identifier) @name) @definition.function

(variable_declaration
  (identifier) @name
  [
    (struct_declaration)
    (enum_declaration)
    (union_declaration)
  ]) @definition.type

(call_expression
  function: [
    (identifier) @name
    (field_expression (identifier) @name)
  ]) @reference.call

