-- 接力开启通知一次性事实戳（发布扇出幂等对账，受控例外 #1 的防重锚点）。
--
-- 背景：发布事务提交后的尾部扇出中，接力通知（relay_open）是唯一非幂等步骤
-- （Notification 表无去重键，重放 = 全体跟随者重复收信）。本字段为物理事实戳：
-- 通知成功发出后落位，发布扇出的一切重放（already-public 重试 / 定时对账）对
-- 该步骤即为 no-op；下架时清除以便重新发布时再次通知。
-- 已知接缝（lib/state/README.md §六）：发送成功但落戳失败的窄窗口会重发一次。
ALTER TABLE "Repository" ADD COLUMN "relayNotifiedAt" TIMESTAMP(3);
