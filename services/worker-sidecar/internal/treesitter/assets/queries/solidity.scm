;; Solidity AST Query
(contract_declaration
  name: (identifier) @name) @definition.type

(function_definition
  name: (identifier) @name) @definition.function

(import_directive
  source: (string) @import.source) @import
