-- Schema 漂移收编：迁移链终点 → schema.prisma 真相的对齐缺口。
--
-- 背景：以下 8 列历史上经 `prisma db push` 带外加列（unpublish 下架冷却、
-- 平台积分/评审运营配置），迁移链从未收录——fresh bootstrap（CI integration
-- 空库 / 新人克隆）产出的 schema 缺列，代码查询即 P2022 崩溃。
-- 由 `prisma migrate diff --from-migrations --to-schema-datamodel` 机器生成，
-- 非手写；ADD COLUMN IF NOT EXISTS 保证对 db push 已建列的存量库幂等。

-- AlterTable
ALTER TABLE "PlatformCreditsConfig" ADD COLUMN IF NOT EXISTS     "contributionVestingDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN IF NOT EXISTS     "initialPublishRewardRatio" DOUBLE PRECISION NOT NULL DEFAULT 0.3;

-- AlterTable
ALTER TABLE "PlatformReviewConfig" ADD COLUMN IF NOT EXISTS     "confidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
ADD COLUMN IF NOT EXISTS     "enforceQualityGate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS     "llmPassThreshold" INTEGER NOT NULL DEFAULT 75,
ADD COLUMN IF NOT EXISTS     "pipelinePassThreshold" INTEGER NOT NULL DEFAULT 70;

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN IF NOT EXISTS     "unpublishCooldownUntil" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS     "unpublishRequestedAt" TIMESTAMP(3);
