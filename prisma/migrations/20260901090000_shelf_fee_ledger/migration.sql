-- 书架收费（按教程劳动账本定价）：账本 / 实付快照 / 计费系数 / 开户礼金标记
ALTER TABLE "Repository" ADD COLUMN "transcriptionCreditsEarned" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SavedRepo" ADD COLUMN "paidCredits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PlatformCreditsConfig" ADD COLUMN "shelfFeeMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0;
ALTER TABLE "User" ADD COLUMN "signupGiftAt" TIMESTAMP(3);
