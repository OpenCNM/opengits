-- VersionSnapshot 只写模型退役（死代码清算 P3-5 拍板 2026-11-13）：
-- MAJOR_VERSION_REBUILD 每次重建写库封存快照，但全仓零读取（版本回滚/对比
-- 功能从未立项）——关闭写入链（apply 路由 archiveVersionSnapshot 调用已删、
-- engine/version-snapshot.ts 已删）后按拍板 DROP 表。
DROP TABLE "VersionSnapshot";
