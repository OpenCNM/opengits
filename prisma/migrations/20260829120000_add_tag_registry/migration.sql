-- 标签注册表（TagRegistry）：管理端维护基础词表，AI 探测从中选择；
-- 词表外新值在导入入库时受控登记（source=ai），防止标签无限膨胀。
-- 注：DocumentChunk.searchVector 等 Prisma 表达不了的伴生 DDL 由
-- reconcile_companion_ddl / migrate:fts 脚本族维护，不在此处触碰。
CREATE TYPE "TagKind" AS ENUM ('CATEGORY', 'TAG');

CREATE TABLE "TagRegistry" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "kind" "TagKind" NOT NULL DEFAULT 'TAG',
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'seed',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TagRegistry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TagRegistry_value_key" ON "TagRegistry"("value");
CREATE INDEX "TagRegistry_kind_isActive_idx" ON "TagRegistry"("kind", "isActive");
