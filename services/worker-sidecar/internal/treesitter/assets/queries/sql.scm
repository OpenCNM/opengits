;; SQL AST Query
(create_table
  (object_reference name: (identifier) @name)) @definition.type

(create_view
  (object_reference name: (identifier) @name)) @definition.type

(create_materialized_view
  (object_reference name: (identifier) @name)) @definition.type

(create_index
  (object_reference name: (identifier) @name)) @definition.type

(create_function
  (object_reference name: (identifier) @name)) @definition.function

