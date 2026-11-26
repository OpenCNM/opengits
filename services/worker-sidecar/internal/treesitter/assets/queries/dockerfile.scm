;; Dockerfile AST Query：多阶段构建的阶段名（FROM ... AS <stage>）是
;; 模块级锚点；其余指令为顺序执行步骤，无声明语义。
(from_instruction
  as: (image_alias) @name) @definition.type
