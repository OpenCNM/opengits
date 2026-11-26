-- Clean up any orphaned reading progress records before adding foreign keys
DELETE FROM "UserReadingProgress" WHERE "userId" NOT IN (SELECT "id" FROM "User");
DELETE FROM "UserReadingProgress" WHERE "repositoryId" NOT IN (SELECT "id" FROM "Repository");

-- AddForeignKey
ALTER TABLE "UserReadingProgress" ADD CONSTRAINT "UserReadingProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReadingProgress" ADD CONSTRAINT "UserReadingProgress_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;