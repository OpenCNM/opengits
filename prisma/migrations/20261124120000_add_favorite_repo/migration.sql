-- CreateTable
CREATE TABLE IF NOT EXISTS "FavoriteRepo" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FavoriteRepo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FavoriteRepo_userId_repositoryId_key" ON "FavoriteRepo"("userId", "repositoryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FavoriteRepo_repositoryId_idx" ON "FavoriteRepo"("repositoryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FavoriteRepo_userId_createdAt_idx" ON "FavoriteRepo"("userId", "createdAt");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FavoriteRepo_userId_fkey') THEN
    ALTER TABLE "FavoriteRepo" ADD CONSTRAINT "FavoriteRepo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FavoriteRepo_repositoryId_fkey') THEN
    ALTER TABLE "FavoriteRepo" ADD CONSTRAINT "FavoriteRepo_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
