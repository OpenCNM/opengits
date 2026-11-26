-- AlterTable
ALTER TABLE "McpCallLog" ADD COLUMN "requestedEdition" TEXT,
ADD COLUMN "resolvedEdition" TEXT,
ADD COLUMN "isFallback" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "McpCallLog_isFallback_createdAt_idx" ON "McpCallLog"("isFallback", "createdAt");
