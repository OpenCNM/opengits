;; Haskell AST Query（节点名按 DebugAST 实证）
(function
  name: (variable) @name) @definition.function

(data_type
  name: (name) @name) @definition.type

(import
  module: (module) @import.source) @import
