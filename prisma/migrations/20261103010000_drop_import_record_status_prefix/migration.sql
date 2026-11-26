-- 退役拆除：ImportRecord.status 与 prefix 历史死字段（全系统只写不读，无行为消费方）
ALTER TABLE "ImportRecord" DROP COLUMN IF EXISTS "prefix";
ALTER TABLE "ImportRecord" DROP COLUMN IF EXISTS "status";
