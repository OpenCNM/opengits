;; TypeScript AST Query
(function_declaration
  name: (identifier) @name) @definition.function

(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name) @definition.variable))

(export_statement
  declaration: (variable_declaration
    (variable_declarator
      name: (identifier) @name) @definition.variable))

(method_definition
  name: (property_identifier) @name) @definition.method

(class_declaration
  name: (type_identifier) @name) @definition.class

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(type_alias_declaration
  name: (type_identifier) @name) @definition.type

(enum_declaration
  name: (identifier) @name) @definition.type

(call_expression
  function: [
    (identifier) @name
    (member_expression property: (property_identifier) @name)
  ]) @reference.call

(import_statement
  source: (string) @import.source) @import

(import_specifier
  name: (identifier) @import.binding)

(import_clause
  (identifier) @import.binding)
