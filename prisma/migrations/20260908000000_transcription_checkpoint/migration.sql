-- Phase 3 #9: chunk 级断点续接存档
-- 指纹 = computeRequestFingerprint（repo+path+gitSha+model+参数）；
-- 指纹不匹配视为无存档（源/模型/参数变了产物必须作废）。

ALTER TABLE "TranscriptionJob" ADD COLUMN "checkpointFingerprint" TEXT NOT NULL DEFAULT '';
ALTER TABLE "TranscriptionJob" ADD COLUMN "checkpointChunks" JSONB;
ALTER TABLE "TranscriptionJob" ADD COLUMN "checkpointTotal" INTEGER;
