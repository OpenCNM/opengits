;; Ruby AST Query
(method
  name: (identifier) @name) @definition.method

(singleton_method
  name: (identifier) @name) @definition.method

(class
  name: [(constant) (scope_resolution)] @name) @definition.class

(module
  name: [(constant) (scope_resolution)] @name) @definition.class

(call
  method: (identifier) @name) @reference.call
