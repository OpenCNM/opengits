;; OCaml AST Query（节点名按 DebugAST 实证）
;; let 绑定到函数：带参数的 let_binding（值名 + ≥1 参数）计为函数定义
(value_definition
  (let_binding
    pattern: (value_name) @name
    (parameter))) @definition.function

;; 模块绑定（module X = ...）
(module_definition
  (module_binding
    name: (module_name) @name)) @definition.type
