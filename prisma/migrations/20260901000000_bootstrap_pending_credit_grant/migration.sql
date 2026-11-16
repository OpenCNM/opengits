-- PendingCreditGrant 自举迁移：修复迁移链在新库上无法自举的缺口。
--
-- 背景：本表在 schema.prisma 中有模型，但历史上仅经 `prisma db push` 带外建表，
-- 迁移链从未创建过它——导致 20261019000000_money_domain_check_constraints 的
-- CHECK 约束迁移在全新数据库上必然失败（relation "PendingCreditGrant" does not
-- exist），fresh bootstrap（含 CI integration job 的空库）无法走通。
--
-- 幂等策略：表与索引用 IF NOT EXISTS（db push 建过的存量库零影响）；外键用
-- duplicate_object 容忍（同 20260827120100_reconcile_companion_ddl 的 DO $$
-- 惯例）。字段/索引/级联定义与 schema.prisma 的 PendingCreditGrant 模型逐一对齐。

-- CreateTable
CREATE TABLE IF NOT EXISTS "PendingCreditGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'IMPORT_CONTRIBUTION',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "unlockAt" TIMESTAMP(3) NOT NULL,
    "unlockedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingCreditGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PendingCreditGrant_userId_status_idx" ON "PendingCreditGrant"("userId", "status");

CREATE INDEX IF NOT EXISTS "PendingCreditGrant_repositoryId_status_idx" ON "PendingCreditGrant"("repositoryId", "status");

CREATE INDEX IF NOT EXISTS "PendingCreditGrant_status_unlockAt_idx" ON "PendingCreditGrant"("status", "unlockAt");

-- AddForeignKeys（存量库若经 db push 已建同名列约束，duplicate_object 静默跳过）
DO $$
BEGIN
  ALTER TABLE "PendingCreditGrant" ADD CONSTRAINT "PendingCreditGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "PendingCreditGrant" ADD CONSTRAINT "PendingCreditGrant_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
