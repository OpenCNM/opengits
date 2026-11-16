-- AlterTable
ALTER TABLE "McpCallLog" ADD COLUMN "clientName" TEXT;

-- CreateIndex
CREATE INDEX "McpCallLog_userId_clientName_createdAt_idx" ON "McpCallLog"("userId", "clientName", "createdAt");
