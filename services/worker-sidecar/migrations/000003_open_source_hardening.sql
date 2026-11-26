-- 开源前数据库加固（与 Prisma migration 20261112000000_open_source_hardening 同步；sqlc schema 增量合成）
-- 1) 删除早期商业化实验死表（Node/Go 代码零引用，先归档后删模型再显式迁移）
DROP TABLE IF EXISTS "RedeemRecord" CASCADE;
DROP TABLE IF EXISTS "RedeemCode" CASCADE;
DROP TABLE IF EXISTS "Subscription" CASCADE;
DROP TABLE IF EXISTS "PlatformCommercialConfig" CASCADE;
-- 2) 删除唯一约束的最左前缀冗余索引（唯一索引本身已服务等值查询）
DROP INDEX IF EXISTS "UserReadingProgress_userId_idx";
DROP INDEX IF EXISTS "SavedRepo_userId_idx";
DROP INDEX IF EXISTS "HelpfulVote_repositoryId_idx";
DROP INDEX IF EXISTS "McpUsageLedger_userId_day_idx";
-- 3) 补齐缺失的 FK 支撑索引（按 userId/repositoryId 的外键查询与级联删除全表扫描）
CREATE INDEX IF NOT EXISTS "Account_userId_idx" ON "Account"("userId");
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");
CREATE INDEX IF NOT EXISTS "ConversationMessage_userId_idx" ON "ConversationMessage"("userId");
CREATE INDEX IF NOT EXISTS "ChapterVersion_repositoryId_idx" ON "ChapterVersion"("repositoryId");
CREATE INDEX IF NOT EXISTS "ChapterVersionVote_userId_idx" ON "ChapterVersionVote"("userId");
CREATE INDEX IF NOT EXISTS "ContentReport_reporterId_idx" ON "ContentReport"("reporterId");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_adminUserId_idx" ON "AdminAuditLog"("adminUserId");
CREATE INDEX IF NOT EXISTS "ChapterQuiz_repositoryId_idx" ON "ChapterQuiz"("repositoryId");
