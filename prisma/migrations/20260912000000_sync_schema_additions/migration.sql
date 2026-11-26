-- AlterTable
ALTER TABLE "GatewayPolicyConfig" ALTER COLUMN "id" SET DEFAULT 'singleton';

-- AlterTable
ALTER TABLE "McpApiToken" ADD COLUMN IF NOT EXISTS "encryptedToken" TEXT;

-- AlterTable
ALTER TABLE "OutlineChapter" ADD COLUMN IF NOT EXISTS "moduleName" TEXT;

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN IF NOT EXISTS "transcriptionTokens" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TranscriptionJob" ALTER COLUMN "checkpointFingerprint" DROP NOT NULL;

-- CreateTable
CREATE TABLE IF NOT EXISTS "VersionSnapshot" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "sha" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VersionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlatformReviewConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "apiKeyEncrypted" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformReviewConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VersionSnapshot_repositoryId_idx" ON "VersionSnapshot"("repositoryId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'VersionSnapshot_repositoryId_fkey'
  ) THEN
    ALTER TABLE "VersionSnapshot" ADD CONSTRAINT "VersionSnapshot_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
