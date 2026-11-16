-- 退役拆除：JIT 首译发酬开关列（与 Prisma migration 20261103000000 同步；sqlc schema 增量合成）
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN IF EXISTS "jitTranscriptionEarnEnabled";
