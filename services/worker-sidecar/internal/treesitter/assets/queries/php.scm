;; PHP AST Query
(function_definition
  name: (name) @name) @definition.function

(method_declaration
  name: (name) @name) @definition.method

(class_declaration
  name: (name) @name) @definition.class

(interface_declaration
  name: (name) @name) @definition.interface

(trait_declaration
  name: (name) @name) @definition.class

(enum_declaration
  name: (name) @name) @definition.type

(function_call_expression
  function: [
    (name) @name
    (qualified_name (name) @name)
  ]) @reference.call

(member_call_expression
  name: (name) @name) @reference.call

(scoped_call_expression
  name: (name) @name) @reference.call


;; Imports: `use App\Models\Order;` → 模块串 "App\Models\Order"（与
;; language-definitions.json 配置模式产出等价，AST 命中即优先供血）
(namespace_use_declaration
  (namespace_use_clause
    (qualified_name) @import.source)) @import
