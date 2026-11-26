;; Java AST Query
(method_declaration
  name: (identifier) @name) @definition.method

(constructor_declaration
  name: (identifier) @name) @definition.method

(class_declaration
  name: (identifier) @name) @definition.class

(interface_declaration
  name: (identifier) @name) @definition.interface

(enum_declaration
  name: (identifier) @name) @definition.type

(record_declaration
  name: (identifier) @name) @definition.class

(field_declaration
  (variable_declarator
    name: (identifier) @name)) @definition.variable

(constant_declaration
  (variable_declarator
    name: (identifier) @name)) @definition.variable

(method_invocation
  name: (identifier) @name) @reference.call
