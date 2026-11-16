;; Lua AST Query
(function_definition_statement
  name: [
    (identifier) @name
    (variable field: (identifier) @name)
    (variable method: (identifier) @name)
  ]) @definition.function

(local_function_definition_statement
  name: (identifier) @name) @definition.function

(call
  function: (variable name: (identifier) @name)) @reference.call

(call
  function: (variable method: (identifier) @name)) @reference.call

(call
  function: (variable field: (identifier) @name)) @reference.call

