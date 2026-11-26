;; MoonBit AST Query（节点名按 node-types + DebugAST 实证；
;; 类型形参/函数体/派生均为具名包装节点，identifier 直子即定义名）
(function_definition
  (function_identifier) @name) @definition.function

(struct_definition
  (identifier) @name) @definition.type

(tuple_struct_definition
  (identifier) @name) @definition.type

(enum_definition
  (identifier) @name) @definition.type

(trait_definition
  (identifier) @name) @definition.type

(import_item
  path: (string_literal) @import.source) @import
