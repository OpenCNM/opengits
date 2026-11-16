-- 收官清算 C6：僵尸写键列 DROP（只写不读，审计判定见收官复核报告）
-- 数据警示：两列存量值随之销毁（errorMessage 仅 FAILED 行、handledBy 仅已处置举报行，均为低价值审计数据）
ALTER TABLE "ContentReport" DROP COLUMN IF EXISTS "handledBy";
ALTER TABLE "ImportUpdateRun" DROP COLUMN IF EXISTS "errorMessage";
