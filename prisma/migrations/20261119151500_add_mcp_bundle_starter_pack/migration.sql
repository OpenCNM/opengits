-- AlterTable
ALTER TABLE "McpBundle"
ADD COLUMN IF NOT EXISTS "isStarterPack" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "starterCategory" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "McpBundle_isStarterPack_isPinned_displayOrder_idx"
ON "McpBundle"("isStarterPack", "isPinned", "displayOrder");
