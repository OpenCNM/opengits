-- 预算熔断通道隔离：PlatformBudgetConfig 增加 sourceQuotas 分桶配额。
-- 背景：平台 key 职责扩展后，单一全局日预算下恶意刷某一通道（如刷发布初审）
-- 会烧干全平台共享额度、拖垮其他平台 key 职责。分桶后各通道只烧自己桶内额度；
-- 未配置桶的 source 仅受全局 platformDailyTokens 约束（向后兼容）。

ALTER TABLE "PlatformBudgetConfig" ADD COLUMN "sourceQuotas" JSONB NOT NULL DEFAULT '{}';
