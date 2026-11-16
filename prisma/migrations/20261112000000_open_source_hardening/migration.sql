-- DropForeignKey
ALTER TABLE "RedeemCode" DROP CONSTRAINT "RedeemCode_createdByAdminId_fkey";

-- DropForeignKey
ALTER TABLE "RedeemRecord" DROP CONSTRAINT "RedeemRecord_codeId_fkey";

-- DropForeignKey
ALTER TABLE "RedeemRecord" DROP CONSTRAINT "RedeemRecord_userId_fkey";

-- DropForeignKey
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_userId_fkey";

-- DropIndex
DROP INDEX "HelpfulVote_repositoryId_idx";

-- DropIndex
DROP INDEX "McpUsageLedger_userId_day_idx";

-- DropIndex
DROP INDEX "SavedRepo_userId_idx";

-- DropIndex
DROP INDEX "UserReadingProgress_userId_idx";

-- DropTable
DROP TABLE "PlatformCommercialConfig";

-- DropTable
DROP TABLE "RedeemCode";

-- DropTable
DROP TABLE "RedeemRecord";

-- DropTable
DROP TABLE "Subscription";

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_adminUserId_idx" ON "AdminAuditLog"("adminUserId");

-- CreateIndex
CREATE INDEX "ChapterQuiz_repositoryId_idx" ON "ChapterQuiz"("repositoryId");

-- CreateIndex
CREATE INDEX "ChapterVersion_repositoryId_idx" ON "ChapterVersion"("repositoryId");

-- CreateIndex
CREATE INDEX "ChapterVersionVote_userId_idx" ON "ChapterVersionVote"("userId");

-- CreateIndex
CREATE INDEX "ContentReport_reporterId_idx" ON "ContentReport"("reporterId");

-- CreateIndex
CREATE INDEX "ConversationMessage_userId_idx" ON "ConversationMessage"("userId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

