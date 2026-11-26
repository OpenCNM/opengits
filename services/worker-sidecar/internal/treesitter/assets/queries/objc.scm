;; Objective-C AST Query（节点名按 DebugAST 实证；名字为裸首子节点）
(class_interface
  . (identifier) @name) @definition.type

(class_implementation
  . (identifier) @name) @definition.type

(method_definition
  (method_type)
  (identifier) @name) @definition.function

(preproc_include
  path: _ @import.source) @import
