-- 收官清算 C6：僵尸写键列 DROP（与 prisma/migrations/20261114090000 同步）
ALTER TABLE "ContentReport" DROP COLUMN IF EXISTS "handledBy";
ALTER TABLE "ImportUpdateRun" DROP COLUMN IF EXISTS "errorMessage";
