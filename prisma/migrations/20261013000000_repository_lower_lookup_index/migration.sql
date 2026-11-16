-- 大小写不敏感仓库解析热路径的函数索引：
-- 热路径（docs 页 resolver / layout / llms-txt / MCP hub）统一使用 mode:'insensitive'，
-- 编译为 LOWER(owner)=LOWER($1) AND LOWER(repo)=LOWER($2)，无法命中普通
-- @@index([owner, repo, branch])（大小写敏感 btree）——宽表隐性顺序扫描。
-- 此处 (lower(owner), lower(repo), branch) 表达式索引让 insensitive 等值查询
-- 走索引前缀收窄（branch/edition 等附加条件仍作 filter，前缀已收窄到组粒度）。
-- 注意：Prisma schema 无法表达表达式索引（无法声明防 db push 误删），
-- 生产部署以 prisma migrate deploy 为权威（docker-entrypoint.sh）。
CREATE INDEX "idx_repository_owner_repo_lower" ON "Repository" ((lower(owner)), (lower(repo)), (branch));
