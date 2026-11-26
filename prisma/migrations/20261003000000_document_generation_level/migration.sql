-- Document 内容等级标注（2026-10）：生成时写入的确定性事实列。
-- 取值域：enhanced / translated / original / code_lesson；NULL = 存量数据未标注。
ALTER TABLE "Document" ADD COLUMN "generationLevel" TEXT;
