-- Document.retryCount 只写不读死列铲除（与 ImportRecord status/prefix 同批清理）：
-- 唯二写入点（转录失败自增 / 手工 reset 归零）均无任何读取方，
-- schema 注释宣称的 "retryMax 内重新拾取" 逻辑并不存在。
ALTER TABLE "Document" DROP COLUMN "retryCount";
