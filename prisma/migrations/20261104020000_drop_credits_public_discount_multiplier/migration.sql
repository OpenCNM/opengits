-- publicDiscountMultiplier 端到端只写不读旋钮铲除（产品决策 2026-11-04）：
-- admin 可编辑/TS 透传/Go settle 装载后从不参与任何奖励或费用计算。
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN "publicDiscountMultiplier";
