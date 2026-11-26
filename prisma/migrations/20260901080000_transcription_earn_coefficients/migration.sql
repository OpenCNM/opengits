-- 转录劳动计酬系数接入 admin 动态配置（市场贡献与 JIT 首译统一口径）
ALTER TABLE "PlatformCreditsConfig" ADD COLUMN "transcriptionEarnMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0;
ALTER TABLE "PlatformCreditsConfig" ADD COLUMN "transcriptionCharsPerCredit" INTEGER NOT NULL DEFAULT 1500;
ALTER TABLE "PlatformCreditsConfig" ADD COLUMN "transcriptionCreditMin" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "PlatformCreditsConfig" ADD COLUMN "transcriptionCreditMax" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "PlatformCreditsConfig" ADD COLUMN "transcriptionCodeMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 2.0;
ALTER TABLE "PlatformCreditsConfig" ADD COLUMN "transcriptionBonusRate" DOUBLE PRECISION NOT NULL DEFAULT 0.5;
ALTER TABLE "PlatformCreditsConfig" ADD COLUMN "jitTranscriptionEarnEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PlatformCreditsConfig" ADD COLUMN "publishGiftEnabled" BOOLEAN NOT NULL DEFAULT false;
