-- 存量大小写归一：MCP 解析层 ILIKE → 精确等值 的数据前提（存储行全小写）。
-- 写入侧自 Phase 18.3 Go 单写者起恒定 strings.ToLower；本迁移清算历史混合行，
-- 使 (owner, repo) 精确等值查询对全部存量行成立（同时让既有表达式索引
-- idx_repository_owner_repo_lower 的等值前缀可直接改走普通 btree 前缀）。
--
-- Fail-Closed：Repository 若小写化后撞 (owner, repo, branch, edition) 唯一键，
-- UPDATE 语句直接报错终止迁移——绝不静默合并两个仓库行（出现该错误说明存在
-- 大小写变体并存的历史脏数据，需 DBA 人工裁决保留方后再重跑本迁移）。
-- ImportJob / ImportRecord 无唯一键约束，纯审计/去重索引行，小写化无冲突风险；
-- 归一它们是为了同仓导入幂等索引 [owner, repo, branch, edition, status] 与
-- 归档 active-key（owner/repo@sha）在新小写口径下不错位。
UPDATE "Repository"   SET owner = lower(owner), repo = lower(repo) WHERE owner <> lower(owner) OR repo <> lower(repo);
UPDATE "ImportJob"   SET owner = lower(owner), repo = lower(repo) WHERE owner <> lower(owner) OR repo <> lower(repo);
UPDATE "ImportRecord" SET owner = lower(owner), repo = lower(repo) WHERE owner <> lower(owner) OR repo <> lower(repo);
