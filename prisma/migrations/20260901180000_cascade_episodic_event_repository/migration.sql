-- Clean up orphaned repositoryId in EpisodicEvent before adding foreign key
UPDATE "EpisodicEvent" SET "repositoryId" = NULL WHERE "repositoryId" IS NOT NULL AND "repositoryId" NOT IN (SELECT "id" FROM "Repository");

-- AddForeignKey
ALTER TABLE "EpisodicEvent" ADD CONSTRAINT "EpisodicEvent_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EpisodicEvent_repositoryId_idx" ON "EpisodicEvent"("repositoryId");