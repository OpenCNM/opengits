-- AlterTable
ALTER TABLE "GatewayPolicyConfig"
  ADD COLUMN "transcriptionConcurrency" INTEGER,
  ADD COLUMN "transcriptionChunkConcurrency" INTEGER,
  ADD COLUMN "llmUserConcurrency" INTEGER,
  ADD COLUMN "llmInteractiveHeadroom" INTEGER;
