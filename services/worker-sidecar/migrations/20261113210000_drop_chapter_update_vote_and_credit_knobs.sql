-- 退役拆除：ChapterUpdateVote 表（试读表决 2026-09-29 退役，写端已拆、零写入方、
-- settle 投票裁定链同批摘除；存量核验 0 行）与 PlatformCreditsConfig 转录计酬
-- 6 死列（Go LoadCreditsConfig 不选、admin 写入口已拆）。
-- 与 Prisma migration 20261113210000 同步；sqlc schema 增量合成。
DROP TABLE IF EXISTS "ChapterUpdateVote";
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN IF EXISTS "transcriptionEarnMultiplier";
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN IF EXISTS "transcriptionCharsPerCredit";
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN IF EXISTS "transcriptionCreditMin";
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN IF EXISTS "transcriptionCreditMax";
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN IF EXISTS "transcriptionCodeMultiplier";
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN IF EXISTS "transcriptionBonusRate";
