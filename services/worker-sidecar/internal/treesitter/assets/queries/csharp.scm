;; C# AST Query
(method_declaration
  name: (identifier) @name) @definition.method

(local_function_statement
  name: (identifier) @name) @definition.function

(constructor_declaration
  name: (identifier) @name) @definition.method

(class_declaration
  name: (identifier) @name) @definition.class

(interface_declaration
  name: (identifier) @name) @definition.interface

(struct_declaration
  name: (identifier) @name) @definition.class

(record_declaration
  name: (identifier) @name) @definition.class

(enum_declaration
  name: (identifier) @name) @definition.type

(invocation_expression
  function: (identifier) @name) @reference.call

(invocation_expression
  function: (member_access_expression name: (identifier) @name)) @reference.call

