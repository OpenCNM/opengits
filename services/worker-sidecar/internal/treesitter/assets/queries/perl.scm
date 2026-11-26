;; Perl AST Query（节点名按 DebugAST 实证）
(subroutine_declaration_statement
  name: (bareword) @name) @definition.function

(package_statement
  name: (package) @name) @definition.type

(use_statement
  module: (package) @import.source) @import
