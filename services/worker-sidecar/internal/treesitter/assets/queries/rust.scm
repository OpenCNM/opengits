;; Rust AST Query
(function_item
  name: (identifier) @name) @definition.function

(struct_item
  name: (type_identifier) @name) @definition.class

(enum_item
  name: (type_identifier) @name) @definition.type

(trait_item
  name: (type_identifier) @name) @definition.interface

(type_item
  name: (type_identifier) @name) @definition.type

(const_item
  name: (identifier) @name) @definition.variable

(static_item
  name: (identifier) @name) @definition.variable

(macro_definition
  name: (identifier) @name) @definition.function

(call_expression
  function: [
    (identifier) @name
    (field_expression field: (field_identifier) @name)
    (scoped_identifier name: (identifier) @name)
  ]) @reference.call

(macro_invocation
  macro: [
    (identifier) @name
    (scoped_identifier name: (identifier) @name)
  ]) @reference.call

(use_declaration
  argument: (_) @import.source) @import

