;; C++ AST Query
(function_definition
  declarator: [
    (function_declarator declarator: (identifier) @name)
    (function_declarator declarator: (field_identifier) @name)
    (function_declarator declarator: (qualified_identifier name: (identifier) @name))
    (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))
    (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name)))
  ]) @definition.function

(declaration
  declarator: [
    (function_declarator declarator: (identifier) @name)
    (function_declarator declarator: (field_identifier) @name)
    (function_declarator declarator: (qualified_identifier name: (identifier) @name))
    (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))
    (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name)))
  ]) @definition.function

(namespace_definition
  name: (namespace_identifier) @name) @definition.type

(class_specifier
  name: (type_identifier) @name) @definition.class

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
    (qualified_identifier name: (identifier) @name)
  ]) @reference.call
