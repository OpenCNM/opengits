-- McpCallLog 补调用者维度：用户隔离查询（/analytics/queries 只看自己，admin 全量）
ALTER TABLE "McpCallLog" ADD COLUMN "userId" TEXT;

CREATE INDEX "McpCallLog_userId_createdAt_idx" ON "McpCallLog"("userId", "createdAt");
