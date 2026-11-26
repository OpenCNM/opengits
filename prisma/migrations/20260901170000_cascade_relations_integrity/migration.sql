-- Clean up orphaned records before adding foreign keys
DELETE FROM "CreditGrantLedger" WHERE "userId" NOT IN (SELECT "id" FROM "User");
UPDATE "CreditGrantLedger" SET "repositoryId" = NULL WHERE "repositoryId" IS NOT NULL AND "repositoryId" NOT IN (SELECT "id" FROM "Repository");
DELETE FROM "ChapterUpdateVote" WHERE "userId" NOT IN (SELECT "id" FROM "User");
DELETE FROM "TutorialConceptEdge" WHERE "repositoryId" NOT IN (SELECT "id" FROM "Repository");
UPDATE "McpCallLog" SET "userId" = NULL WHERE "userId" IS NOT NULL AND "userId" NOT IN (SELECT "id" FROM "User");
UPDATE "McpCallLog" SET "repositoryId" = NULL WHERE "repositoryId" IS NOT NULL AND "repositoryId" NOT IN (SELECT "id" FROM "Repository");
UPDATE "McpCallLog" SET "bundleId" = NULL WHERE "bundleId" IS NOT NULL AND "bundleId" NOT IN (SELECT "id" FROM "McpBundle");

-- AddForeignKey
ALTER TABLE "CreditGrantLedger" ADD CONSTRAINT "CreditGrantLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditGrantLedger" ADD CONSTRAINT "CreditGrantLedger_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChapterUpdateVote" ADD CONSTRAINT "ChapterUpdateVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TutorialConceptEdge" ADD CONSTRAINT "TutorialConceptEdge_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpCallLog" ADD CONSTRAINT "McpCallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "McpCallLog" ADD CONSTRAINT "McpCallLog_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "McpCallLog" ADD CONSTRAINT "McpCallLog_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "McpBundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CreditGrantLedger_repositoryId_idx" ON "CreditGrantLedger"("repositoryId");
CREATE INDEX IF NOT EXISTS "ChapterUpdateVote_userId_idx" ON "ChapterUpdateVote"("userId");
CREATE INDEX IF NOT EXISTS "McpCallLog_bundleId_idx" ON "McpCallLog"("bundleId");