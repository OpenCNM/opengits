;; Julia AST Query（短式函数 `f(x) = ...`、struct、module、import）
(assignment
  (call_expression
    (identifier) @name)) @definition.function

(struct_definition
  (type_head
    (identifier) @name)) @definition.type

(module_definition
  name: (identifier) @name) @definition.type

(import_statement
  (selected_import
    (identifier) @import.source)) @import
