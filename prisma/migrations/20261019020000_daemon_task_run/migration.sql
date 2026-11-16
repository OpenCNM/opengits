-- Go daemon 任务运行台账（自愈回路可观测性闭环）。
--
-- 背景：orphan-sweeper / search-sync / vesting-reaper / publish-fanout-reconcile 等
-- 无人值守自愈回路此前只有 stdout 日志——任务静默跳过（如 NODE_INTERNAL_URL 未配置）
-- 或持续失败都无人知晓。本表每轮一条汇总行（宪章公理 5：单条关联台账行，
-- 禁止逐事件写放大），task-health-alert 任务按「连续 failed ≥ 3」窗口告警。
-- 写者唯一：Go runner.runOnce（经 sqlc InsertDaemonTaskRun）；id 由 SQL 侧
-- gen_random_uuid() 生成（Go 不产 cuid，Node 不写本表）。
CREATE TABLE "DaemonTaskRun" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DaemonTaskRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DaemonTaskRun_task_createdAt_idx" ON "DaemonTaskRun"("task", "createdAt");
