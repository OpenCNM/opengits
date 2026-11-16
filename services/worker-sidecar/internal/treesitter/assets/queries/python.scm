;; Python AST Query
(function_definition
  name: (identifier) @name) @definition.function

(class_definition
  name: (identifier) @name) @definition.class

(call
  function: [
    (identifier) @name
    (attribute attribute: (identifier) @name)
  ]) @reference.call

(import_statement
  name: (dotted_name) @import.source) @import

(import_from_statement
  module_name: [(dotted_name) (relative_import)] @import.source) @import

(import_from_statement
  name: (dotted_name (identifier) @import.binding))

(import_from_statement
  name: (aliased_import name: (dotted_name (identifier) @import.binding)))

;; Module-level top-level variable / constant assignments (e.g. PromptTemplate declarations)
(module
  (expression_statement
    (assignment
      left: (identifier) @name)) @definition.variable)
