;; Gleam AST Query（节点名/字段按 DebugAST 实证）
(function
  name: (identifier) @name) @definition.function

(constant
  name: (identifier) @name) @definition.function

(external_function
  name: (identifier) @name) @definition.function

(import
  module: (module) @import.source) @import

(type_definition
  (type_name name: (type_identifier) @name)) @definition.type
