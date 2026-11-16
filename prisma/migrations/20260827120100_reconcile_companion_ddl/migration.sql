-- 收编伴生脚本 DDL 进迁移链（消除 migrate dev 漂移检测）。原 companion 脚本已退役。
-- vector 扩展非 stock postgres 镜像自带：宿主无此扩展时静默跳过（既有库已装则在此登记进历史）。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE "DocumentChunk"
  ADD COLUMN IF NOT EXISTS "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce("heading", '') || ' ' || coalesce("content", ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_chunk_fts ON "DocumentChunk" USING GIN ("searchVector");
CREATE INDEX IF NOT EXISTS idx_chunk_trgm_content ON "DocumentChunk" USING GIN ("content" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_chunk_trgm_heading ON "DocumentChunk" USING GIN ("heading" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_repo_skeleton_trgm ON "Repository" USING GIN ("skeleton" gin_trgm_ops);
