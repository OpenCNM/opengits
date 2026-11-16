;; R AST Query（命名函数绑定：`name <- function(...)`；调用站点）
(binary_operator
  lhs: (identifier) @name
  rhs: (function_definition)) @definition.function

(call
  function: (identifier) @name) @reference.call
