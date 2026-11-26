-- 全书收尾审计（Book Final Audit）存储语句。
--
-- 状态载体：Repository.repoProfile -> 'bookAudit' =
--   {status, claimedAt, attempts, scopeHash, finishedAt}
-- status 取值：running | done | failed | skipped_conflict | skipped_no_llm |
--              skipped_no_author | skipped_no_commit_store
-- 可重试态（retryableStatuses）：failed / skipped_no_llm / skipped_no_author /
--   skipped_no_commit_store——同一范围（scopeHash 未变）内次数未耗尽即可再占。
--
-- 作用域子句（三个查询必须保持一致）：仓库 + 虚拟章节路径前缀 + 文档归属。
-- ownerUserId 为 NULL 表示共享行；非空表示该用户的私有副本。同一仓库可同时
-- 存在共享行与多个用户的私有行，他人的行既不阻塞触发也不混入审计对象。

-- name: BookAuditCountUnsettledChapters :one
SELECT count(*) FROM "Document"
WHERE "repositoryId" = sqlc.arg('repositoryId')
  AND status IN ('UNPROCESSED', 'PROCESSING')
  AND path LIKE sqlc.arg('pathPrefix')
  AND ((sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL)
       OR (sqlc.narg('ownerUserId')::text IS NOT NULL AND "ownerUserId" = sqlc.narg('ownerUserId')::text));

-- name: BookAuditListChapterScope :many
SELECT path, "contentId" FROM "Document"
WHERE "repositoryId" = sqlc.arg('repositoryId')
  AND status = 'PROCESSED'
  AND path LIKE sqlc.arg('pathPrefix')
  AND ((sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL)
       OR (sqlc.narg('ownerUserId')::text IS NOT NULL AND "ownerUserId" = sqlc.narg('ownerUserId')::text))
ORDER BY path ASC;

-- 已成稿章节清单。正文读取顺序与读者一致：内容层（DocumentContent）优先，legacy
-- content 列兜底——非双写部署里 legacy 列为 NULL。
-- name: BookAuditListProcessedChapters :many
SELECT d.id,
       d.path,
       COALESCE(d.title, d.path) AS title,
       COALESCE(dc.content, d.content, '')::text AS content,
       d."contentId",
       d."updatedAt",
       d."gitSha",
       d."generationModel",
       COALESCE(dc.lang, '')::text AS lang,
       d."ownerUserId"
FROM "Document" d
LEFT JOIN "DocumentContent" dc ON dc.id = d."contentId"
WHERE d."repositoryId" = sqlc.arg('repositoryId')
  AND d.status = 'PROCESSED'
  AND d.path LIKE sqlc.arg('pathPrefix')
  AND ((sqlc.narg('ownerUserId')::text IS NULL AND d."ownerUserId" IS NULL)
       OR (sqlc.narg('ownerUserId')::text IS NOT NULL AND d."ownerUserId" = sqlc.narg('ownerUserId')::text))
ORDER BY d.path ASC;

-- 原子占坑（单语句条件 UPDATE 仲裁出唯一执行者）。四种可占情况：
--   1. 无记录；
--   2. running 且 claimedAt 早于 staleBefore（执行者崩溃遗留，锁随会话释放后可重占）；
--   3. 可重试态、同一范围、次数未耗尽；
--   4. 任何非 running 状态但范围变化（章节集合/内容变了：补录章节、重转录）。
-- attempts 在"新范围"下从 1 重计，其余情况累加。
-- name: BookAuditTryClaim :execrows
UPDATE "Repository"
SET "repoProfile" = jsonb_set(
      COALESCE("repoProfile", '{}'::jsonb), '{bookAudit}',
      jsonb_build_object(
        'status', 'running',
        'claimedAt', now(),
        'attempts',
          CASE
            WHEN (COALESCE("repoProfile", '{}'::jsonb) -> 'bookAudit' ->> 'status') IS NULL
              OR (COALESCE("repoProfile", '{}'::jsonb) -> 'bookAudit' ->> 'scopeHash') IS DISTINCT FROM sqlc.arg('scopeHash')::text
            THEN 1
            ELSE COALESCE(((COALESCE("repoProfile", '{}'::jsonb) -> 'bookAudit' ->> 'attempts'))::int, 0) + 1
          END,
        'scopeHash', sqlc.arg('scopeHash')::text),
      true),
    "updatedAt" = now()
WHERE id = sqlc.arg('repositoryId')
  AND (
    (COALESCE("repoProfile", '{}'::jsonb) -> 'bookAudit' ->> 'status') IS NULL
    OR ((COALESCE("repoProfile", '{}'::jsonb) -> 'bookAudit' ->> 'status') = 'running'
        AND (COALESCE("repoProfile", '{}'::jsonb) -> 'bookAudit' ->> 'claimedAt')::timestamptz < sqlc.arg('staleBefore')::timestamptz)
    OR ((COALESCE("repoProfile", '{}'::jsonb) -> 'bookAudit' ->> 'status') = ANY(sqlc.slice('retryableStatuses')::text[])
        AND (COALESCE("repoProfile", '{}'::jsonb) -> 'bookAudit' ->> 'scopeHash') IS NOT DISTINCT FROM sqlc.arg('scopeHash')::text
        AND COALESCE(((COALESCE("repoProfile", '{}'::jsonb) -> 'bookAudit' ->> 'attempts'))::int, 0) < sqlc.arg('maxAttempts')::int)
    OR ((COALESCE("repoProfile", '{}'::jsonb) -> 'bookAudit' ->> 'status') <> 'running'
        AND (COALESCE("repoProfile", '{}'::jsonb) -> 'bookAudit' ->> 'scopeHash') IS DISTINCT FROM sqlc.arg('scopeHash')::text)
  );

-- 状态落记：合并写入，保留 claimedAt / attempts / scopeHash。
-- name: BookAuditMarkStatus :execrows
UPDATE "Repository"
SET "repoProfile" = jsonb_set(
      COALESCE("repoProfile", '{}'::jsonb), '{bookAudit}',
      COALESCE("repoProfile" -> 'bookAudit', '{}'::jsonb)
        || jsonb_build_object('status', sqlc.arg('status')::text, 'finishedAt', now()),
      true),
    "updatedAt" = now()
WHERE id = sqlc.arg('repositoryId');

-- 仓库审核态预检（硬护栏在 BookAuditSwapChapter 的 CAS 条件内；本查询只用于
-- 提前省掉注定无法写回的修理 LLM 调用）。
-- name: BookAuditRepoUnderReviewOrPublic :one
SELECT ("reviewStatus" IN ('PENDING', 'APPROVED')) OR "isPublic" FROM "Repository" WHERE id = sqlc.arg('repositoryId');

-- 审计修理的正典换入（CAS）：
--   条件 = 仍是 PROCESSED + 内容层指针未变 + 行未被并发改动（updatedAt 相等）
--          + 仓库未在审核且未公开（护栏内联，杜绝检查-使用窗口）。
--   content 列写法与 StampDocumentProcessed 停写语义一致：新 contentId 恒非空，
--   非双写部署下 legacy 列置 NULL，不留旧正文。
--   不触碰 gitSha / generationModel / generationLevel（修理不改变来源与生成模型）。
-- name: BookAuditSwapChapter :execrows
UPDATE "Document" AS d SET
  "contentId" = sqlc.arg('contentId'),
  content = CASE WHEN sqlc.arg('dualWrite')::boolean THEN sqlc.arg('content')::text ELSE NULL END,
  "updatedAt" = now()
WHERE d.id = sqlc.arg('documentId')
  AND d.status = 'PROCESSED'
  AND d."contentId" IS NOT DISTINCT FROM sqlc.narg('expectedContentId')::text
  AND d."updatedAt" = sqlc.arg('expectedUpdatedAt')
  AND NOT EXISTS (
    SELECT 1 FROM "Repository" r
    WHERE r.id = d."repositoryId"
      AND (r."reviewStatus" IN ('PENDING', 'APPROVED') OR r."isPublic"));

-- 审计修理产生的正典版本登记（source = 'AUDIT'；PUBLIC——私有版本会被版本回收
-- 无条件清除，正典指针将悬垂）。
-- name: BookAuditInsertCanonicalVersion :exec
INSERT INTO "ChapterVersion" (
  id, "documentId", "repositoryId", "authorId", "contentId",
  source, visibility, "isCanonical", "createdAt", "updatedAt"
) VALUES (
  gen_random_uuid()::text, sqlc.arg('documentId'), sqlc.arg('repositoryId'), sqlc.arg('authorId'), sqlc.arg('contentId'),
  'AUDIT', 'PUBLIC', true, now(), now()
);
