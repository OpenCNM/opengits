;; Dart AST Query
(function_signature
  name: (identifier) @name) @definition.function

(getter_signature
  name: (identifier) @name) @definition.method

(setter_signature
  name: (identifier) @name) @definition.method

(constructor_signature
  name: (identifier) @name) @definition.method

(factory_constructor_signature
  (identifier)
  (identifier) @name) @definition.method

(class_definition
  name: (identifier) @name) @definition.class

(enum_declaration
  name: (identifier) @name) @definition.type

(mixin_declaration
  name: (identifier) @name) @definition.class

(extension_declaration
  name: (identifier) @name) @definition.class

(_
  (identifier) @name
  (selector (argument_part))) @reference.call

(_
  (selector
    (unconditional_assignable_selector (identifier) @name))
  (selector (argument_part))) @reference.call
