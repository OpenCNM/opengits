-- 积分发放台账：市场外贡献发放（JIT 首译等）入账，capDailyEarn 日上限第二聚合源
CREATE TABLE "CreditGrantLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "repositoryId" TEXT,
    "path" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditGrantLedger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreditGrantLedger_userId_createdAt_idx" ON "CreditGrantLedger"("userId", "createdAt");
