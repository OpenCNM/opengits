-- 巨仓社区接力：发布者开关 + 任务类型
-- RELAY = 首译悬赏（接力窗口按 path 顺序惰性生成，fromSha=toSha）
ALTER TABLE "Repository" ADD COLUMN "relayEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChapterUpdateJob" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'UPDATE';
