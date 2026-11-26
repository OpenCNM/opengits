;; Scala AST Query
(function_definition
  name: (identifier) @name) @definition.function

(class_definition
  name: (identifier) @name) @definition.class

(object_definition
  name: (identifier) @name) @definition.class

(trait_definition
  name: (identifier) @name) @definition.interface

(call_expression
  function: [
    (identifier) @name
    (field_expression field: (identifier) @name)
  ]) @reference.call
