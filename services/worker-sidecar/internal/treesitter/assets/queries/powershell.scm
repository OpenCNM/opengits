;; PowerShell AST Query（节点名按 DebugAST 实证）
(function_statement
  (function_name) @name) @definition.function

(command
  command_name: (command_name) @name) @reference.call
