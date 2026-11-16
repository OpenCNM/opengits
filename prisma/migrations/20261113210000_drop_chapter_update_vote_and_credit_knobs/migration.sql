-- ChapterUpdateVote 表 DROP（死代码清算 W4d 2026-11-13）：
-- 试读表决链路 2026-09-29 退役（写端 vote 路由物理删除），零写入方；
-- 唯一读者（market settle 投票裁定链）已随本批摘除，Go market.sql 查询同步移除。
-- 存量核验（2026-11-13 dev 库）：ChapterUpdateVote 0 行、未终态 TRIAL 0、
-- voteDeadline 非空 0——零数据丢失。
DROP TABLE "ChapterUpdateVote";

-- PlatformCreditsConfig 转录计酬 6 死列（发酬双轨退役遗留，与已 DROP 的
-- publicDiscountMultiplier / jitTranscriptionEarnEnabled 同族）：
-- Go LoadCreditsConfig 不选、admin 写入口已拆、业务零消费（token 级验证）。
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN "transcriptionEarnMultiplier";
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN "transcriptionCharsPerCredit";
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN "transcriptionCreditMin";
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN "transcriptionCreditMax";
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN "transcriptionCodeMultiplier";
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN "transcriptionBonusRate";
