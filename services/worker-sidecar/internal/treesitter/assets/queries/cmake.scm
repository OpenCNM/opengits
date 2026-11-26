;; CMake AST Query：function/macro 名是 argument_list 的首个位置参数——
;; 子节点锚点 `.` 钉住第一个 argument，避免把后续形参捕成幻影符号。
(function_def
  (function_command (argument_list . (argument) @name))) @definition.function

(macro_def
  (macro_command (argument_list . (argument) @name))) @definition.function
