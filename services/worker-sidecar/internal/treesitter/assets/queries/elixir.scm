;; Elixir AST Query
(call
  target: (identifier) @_def
  (arguments
    [
      (call target: (identifier) @name)
      (binary_operator left: (call target: (identifier) @name))
    ])
  (#match? @_def "^(def|defp|defmacro)$")) @definition.function

(call
  target: (identifier) @_defmodule
  (arguments
    (alias) @name)
  (#eq? @_defmodule "defmodule")) @definition.class

(call
  target: [
    (identifier) @name
    (dot right: (identifier) @name)
  ]
  (arguments)) @reference.call

