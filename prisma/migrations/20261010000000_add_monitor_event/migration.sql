-- 前端自研监控事件表：报错/卡死/性能，append-only 流水（Go worker-sidecar 单写者）
-- CreateTable
CREATE TABLE "MonitorEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "userId" TEXT,
    "repositoryId" TEXT,
    "fingerprint" TEXT,
    "severity" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitorEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonitorEvent_kind_createdAt_idx" ON "MonitorEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "MonitorEvent_fingerprint_createdAt_idx" ON "MonitorEvent"("fingerprint", "createdAt");

-- CreateIndex
CREATE INDEX "MonitorEvent_sessionId_idx" ON "MonitorEvent"("sessionId");
