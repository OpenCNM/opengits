;; C AST Query
(function_definition
  declarator: [
    (function_declarator declarator: (identifier) @name)
    (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))
  ]) @definition.function

(declaration
  declarator: [
    (function_declarator declarator: (identifier) @name)
    (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))
  ]) @definition.function

(struct_specifier
  name: (type_identifier) @name) @definition.class

(enum_specifier
  name: (type_identifier) @name) @definition.type

(type_definition
  declarator: (type_identifier) @name) @definition.type

(call_expression
  function: [
    (identifier) @name
    (field_expression field: (field_identifier) @name)
  ]) @reference.call
