;; Swift AST Query
(function_declaration
  name: (simple_identifier) @name) @definition.function

(class_declaration
  name: (type_identifier) @name) @definition.class

(protocol_declaration
  name: (type_identifier) @name) @definition.interface

(call_expression
  [
    (simple_identifier) @name
    (navigation_expression suffix: (navigation_suffix suffix: (simple_identifier) @name))
  ]) @reference.call


