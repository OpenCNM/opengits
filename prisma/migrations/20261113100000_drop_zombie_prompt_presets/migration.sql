-- 僵尸 prompt 模板清除（死代码清算 2026-11-13，两批合计 5 键）：
-- 批1 ai_repo_sniffer / scout_outline_draft：运行时零调用（Go 侧 LLM purpose 清单实测不含）；
-- 批2 scout_structurizer / curriculum_synthesizer / webdoc_orchestrator：preset 模板
--     三层齐备但零 invoker（registry 无 purpose 或无调用方，ai_repo_sniff 同口径裁定）。
-- 代码侧 preset/registry/admin 词条已物理删除；DB 行为 seedMissingPresets 仅插入
-- 不删除的遗留种子，PromptVersion 经 onDelete: Cascade 级联清除。
DELETE FROM "SystemPrompt" WHERE "key" IN (
  'ai_repo_sniffer',
  'scout_outline_draft',
  'scout_structurizer',
  'curriculum_synthesizer',
  'webdoc_orchestrator'
);
