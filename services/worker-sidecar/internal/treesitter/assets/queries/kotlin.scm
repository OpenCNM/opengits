;; Kotlin AST Query
(function_declaration
  (simple_identifier) @name) @definition.function

(class_declaration
  (type_identifier) @name) @definition.class

(object_declaration
  (type_identifier) @name) @definition.class

(call_expression
  [
    (simple_identifier) @name
    (navigation_expression (navigation_suffix (simple_identifier) @name))
  ]) @reference.call

