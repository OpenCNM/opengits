-- 仓内概念归并层（L1）：TutorialConceptNode 增加 canonicalKey / canonicalName。
-- canonicalKey = normalizeHeadingKey(conceptName)（去空白/小写/剥前导编号），同仓同 key 视为
-- 同一概念组；canonicalName = 组内代表性显示名（频次最高，同频取字典序最小）。
-- 均为 nullable：存量节点未回填前按「未归并」参与查询，由 runCanonicalBackfill 补齐。
-- 注：DocumentChunk.searchVector 等 Prisma 表达不了的伴生 DDL 由
-- reconcile_companion_ddl / migrate:fts 脚本族维护，不在此处触碰。
ALTER TABLE "TutorialConceptNode" ADD COLUMN "canonicalKey" TEXT;
ALTER TABLE "TutorialConceptNode" ADD COLUMN "canonicalName" TEXT;
CREATE INDEX "TutorialConceptNode_repositoryId_canonicalKey_idx" ON "TutorialConceptNode"("repositoryId", "canonicalKey");
