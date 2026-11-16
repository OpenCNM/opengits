;; Typst AST Query：#let 绑定——常量式绑定 pattern 为 ident，
;; 函数式绑定 pattern 为 call（item 字段即函数名）；markup 正文不做符号提取。
(let
  pattern: (ident) @name) @definition.function

(let
  pattern: (call item: (ident) @name)) @definition.function
