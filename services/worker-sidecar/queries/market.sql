-- name: MarketReleaseExpiredClaims :execrows
update "ChapterUpdateJob"
SET status = 'PENDING', "claimedBy" = NULL, "claimedUntil" = NULL, "frozenCredits" = 0, "updatedAt" = now()
WHERE status = 'CLAIMED' AND "claimedUntil" < now();

-- name: MarketFailTrialsWithoutStaging :execrows
update "ChapterUpdateJob"
SET status = 'FAILED', "errorMessage" = '试读超时且暂存内容缺失', "updatedAt" = now()
WHERE status = 'TRIAL' AND "voteDeadline" < now()
  AND NOT EXISTS (SELECT 1 FROM "DocumentContent" dc WHERE dc.id = "ChapterUpdateJob"."stagedContentId");

-- name: MarketListExpiredMarketTrials :many
SELECT id, "repositoryId", "documentId", path, "toSha", "claimedBy",
       "stagedContentId", "stagedModel"
FROM "ChapterUpdateJob"
WHERE status = 'TRIAL' AND "voteDeadline" < sqlc.arg('voteDeadline')
  AND "stagedContentId" IS NOT NULL
  AND ((sqlc.narg('excludeIds')::text[] IS NULL) OR (id <> ALL(sqlc.narg('excludeIds')::text[])))
ORDER BY "voteDeadline" ASC LIMIT sqlc.arg('limit');

-- name: MarketSettleSwapTxJob :execrows
update "ChapterUpdateJob"
SET status = 'SWAPPED', "actualCredits" = 0, "updatedAt" = now()
WHERE id = sqlc.arg('id') AND status = 'TRIAL' AND "stagedContentId" = sqlc.arg('stagedContentId');

-- name: MarketSettleSwapTxDoc :exec
UPDATE "Document" SET
  "contentId" = sqlc.arg('contentId'),
  content = CASE WHEN sqlc.arg('dualWrite')::boolean THEN sqlc.arg('content')::text ELSE NULL END,
  status = 'PROCESSED',
  "errorMessage" = NULL,
  "gitSha" = sqlc.arg('gitSha'),
  "generationModel" = NULLIF(sqlc.arg('generationModel')::text, ''),
  "updatedAt" = now()
WHERE id = sqlc.arg('id');

-- name: MarketRecordMarketSettledEvent :exec
INSERT INTO "EpisodicEvent" (id, "userId", "pageUrl", "eventType", "metadata", "createdAt")
VALUES (gen_random_uuid()::text, sqlc.arg('userId'), '/relay-market', 'RELAY_JOB_SETTLED', sqlc.arg('metadata')::jsonb, now());

-- name: MarketIncrementAutoSwapCount :one
UPDATE "Repository" SET "autoSwapCount" = COALESCE("autoSwapCount",0) + 1, "updatedAt" = now()
WHERE id = sqlc.arg('id') RETURNING "autoSwapCount";

-- name: MarketSetQualityHold :exec
UPDATE "Repository" SET "qualityHold" = true, "updatedAt" = now() WHERE id = sqlc.arg('id');

-- name: MarketLoadStagedContent :one
SELECT content FROM "DocumentContent" WHERE id = sqlc.arg('id');

-- name: MarketLoadOutlineChapterCount :one
SELECT COUNT(*) FROM "OutlineChapter" c
JOIN "TutorialOutline" o ON o.id = c."outlineId"
WHERE o."repositoryId" = sqlc.arg('repositoryId') AND o."isActive" = true;

-- name: MarketLoadPipelineScoreDocs :many
-- 正文必须走内容寻址层：DOCUMENT_CONTENT_DUAL_WRITE 关闭的部署里 legacy
-- content 列为 NULL，旧查询读出空串 → 三维全 0 → 总分上限 44 < 阈值 70，
-- 已迁移仓在复检路径被全站误杀 qualityHold（auto-update 整体跳过）。
SELECT d.status, COALESCE(dc.content, d.content, '')::text AS content
FROM "Document" d
LEFT JOIN "DocumentContent" dc ON dc."id" = d."contentId"
WHERE d."repositoryId" = sqlc.arg('repositoryId');

-- name: MarketListActiveJobs :many
SELECT j.id, j."documentId", j.path, j.status, j.kind, j."fromSha", j."toSha",
       j."claimedBy", j."voteDeadline", j."frozenCredits", d.title
FROM "ChapterUpdateJob" j
LEFT JOIN "Document" d ON d.id = j."documentId"
WHERE j."repositoryId" = sqlc.arg('repositoryId') AND j.status IN ('PENDING', 'CLAIMED', 'TRIAL')
ORDER BY j."createdAt" ASC
LIMIT 50;

-- name: MarketGetJobAuthInfo :one
SELECT j.id, j."repositoryId", j.kind, j.status, r."isPublic"
FROM "ChapterUpdateJob" j
JOIN "Repository" r ON r.id = j."repositoryId"
WHERE j.id = sqlc.arg('id');

-- name: MarketGetJobAuthInfoDocFallback :one
SELECT d.id, d."repositoryId", 'RELAY'::text AS kind, 'PENDING'::text AS status, r."isPublic"
FROM "Document" d
JOIN "Repository" r ON r.id = d."repositoryId"
WHERE d.id = sqlc.arg('id');

-- name: MarketClaimJob :execrows
update "ChapterUpdateJob"
SET status = 'CLAIMED',
    "claimedBy" = sqlc.arg('claimedBy'),
    "claimedUntil" = now() + (sqlc.arg('ttlMinutes')::text || ' minutes')::interval,
    "frozenCredits" = 0,
    "updatedAt" = now()
WHERE id = sqlc.arg('id')
  AND status = 'PENDING'
  AND ("claimedUntil" IS NULL OR "claimedUntil" < now());

-- name: MarketGetJobStatus :one
SELECT status FROM "ChapterUpdateJob" WHERE id = sqlc.arg('id');

-- name: MarketReleaseClaim :execrows
update "ChapterUpdateJob"
SET status = 'PENDING',
    "claimedBy" = NULL,
    "claimedUntil" = NULL,
    "frozenCredits" = 0,
    "updatedAt" = now()
WHERE id = sqlc.arg('id')
  AND status = 'CLAIMED'
  AND "claimedBy" = sqlc.arg('claimedBy');

-- name: MarketExtendClaim :execrows
-- 认领租约续期（CAS：仅本人持有且未过期的 CLAIMED 租约可续）。
-- 2026-10-13 批量接力异步化随附：批量认领的任务在进程内队列排队等待执行，
-- 开始执行前/长任务执行期间续期，覆盖排队耗时；过期租约不可复活（回池语义不变）。
update "ChapterUpdateJob"
SET "claimedUntil" = now() + (sqlc.arg('ttlMinutes')::text || ' minutes')::interval,
    "updatedAt" = now()
WHERE id = sqlc.arg('id')
  AND status = 'CLAIMED'
  AND "claimedBy" = sqlc.arg('claimedBy')
  AND "claimedUntil" > now();

-- name: MarketAdvisoryLock :exec
SELECT pg_advisory_xact_lock(hashtext(sqlc.arg('key')::text));

-- name: MarketSettleRelayTxUpdateJob :execrows
update "ChapterUpdateJob"
SET status = 'SWAPPED',
    "stagedContentId" = sqlc.arg('stagedContentId'),
    "stagedModel" = sqlc.narg('stagedModel'),
    "updatedAt" = now()
WHERE id = sqlc.arg('id') AND status = 'CLAIMED' AND "claimedBy" = sqlc.arg('claimedBy');

-- name: MarketSettleRelayTxUpdateVersion :exec
UPDATE "ChapterVersion"
SET "isCanonical" = false, "updatedAt" = now()
WHERE "documentId" = sqlc.arg('documentId') AND "isCanonical" = true;

-- name: MarketSettleRelayTxInsertVersion :exec
INSERT INTO "ChapterVersion" (
    id, "documentId", "repositoryId", "authorId", "contentId",
    source, visibility, "isCanonical", "createdAt", "updatedAt"
) VALUES (
    gen_random_uuid()::text, sqlc.arg('documentId'), sqlc.arg('repositoryId'), sqlc.arg('authorId'), sqlc.arg('contentId'),
    'RELAY', 'PUBLIC', true, now(), now()
);

-- name: MarketMarkJobFailed :execrows
update "ChapterUpdateJob"
SET status = 'FAILED',
    "errorMessage" = sqlc.arg('errorMessage'),
    "updatedAt" = now()
WHERE id = sqlc.arg('id')
  AND status = 'CLAIMED'
  AND "claimedBy" = sqlc.arg('claimedBy');


-- name: MarketEnsureRelayJobGetDoc :one
SELECT d.id, d.path, d."repositoryId", r."gitSha"
FROM "Document" d
JOIN "Repository" r ON r.id = d."repositoryId"
WHERE d.id = sqlc.arg('id');

-- name: MarketEnsureRelayJobGetJob :one
SELECT id, "repositoryId", kind, status, "claimedUntil"
FROM "ChapterUpdateJob"
WHERE "documentId" = sqlc.arg('documentId') AND kind = 'RELAY' AND status IN ('PENDING', 'CLAIMED', 'TRIAL')
ORDER BY "createdAt" DESC LIMIT 1;

-- name: MarketEnsureRelayJobUpdateJob :exec
update "ChapterUpdateJob"
SET status = 'PENDING', "claimedBy" = NULL, "claimedUntil" = NULL, "frozenCredits" = 0, "updatedAt" = now()
WHERE id = sqlc.arg('id') AND status = 'CLAIMED' AND "claimedUntil" < now();

-- name: MarketEnsureRelayJobInsertJob :one
INSERT INTO "ChapterUpdateJob" (
    id, "repositoryId", "documentId", path, "fromSha", "toSha", kind, status, "frozenCredits", "createdAt", "updatedAt"
) VALUES (
    gen_random_uuid()::text, sqlc.arg('repositoryId'), sqlc.arg('documentId'), sqlc.arg('path'), sqlc.arg('fromSha'), sqlc.arg('toSha'), 'RELAY', 'PENDING', 0, now(), now()
) RETURNING id, "repositoryId", kind, status;

-- name: MarketCreateRetranslateJob :exec
INSERT INTO "ChapterUpdateJob" (
    id, "repositoryId", "documentId", path, "fromSha", "toSha",
    kind, status, "claimedBy", "claimedUntil", "stagedContentId", "stagedModel",
    "frozenCredits", "createdAt", "updatedAt"
) VALUES (
    gen_random_uuid()::text, sqlc.arg('repositoryId'), sqlc.arg('documentId'), sqlc.arg('path'), sqlc.arg('fromSha'), sqlc.arg('toSha'),
    'RETRANSLATE', 'SWAPPED', sqlc.arg('claimedBy'), now(), sqlc.arg('stagedContentId'), sqlc.narg('stagedModel'),
    0, now(), now()
);

-- name: MarketCreateStaleJobsGetDocs :many
SELECT id, path FROM "Document"
WHERE "repositoryId" = sqlc.arg('repositoryId') AND "ownerUserId" IS NULL AND status = 'PROCESSED' AND path = ANY(sqlc.arg('paths')::text[]);

-- name: MarketCreateStaleJobsGetBusy :many
SELECT "documentId" FROM "ChapterUpdateJob"
WHERE "repositoryId" = sqlc.arg('repositoryId') AND status IN ('PENDING', 'CLAIMED', 'TRIAL');

-- name: MarketCreateStaleJobsInsertJob :exec
INSERT INTO "ChapterUpdateJob" (
    id, "repositoryId", "documentId", path, "fromSha", "toSha",
    kind, status, "frozenCredits", "createdAt", "updatedAt"
) VALUES (
    gen_random_uuid()::text, sqlc.arg('repositoryId'), sqlc.arg('documentId'), sqlc.arg('path'), sqlc.arg('fromSha'), sqlc.arg('toSha'),
    'UPDATE', 'PENDING', 0, now(), now()
);

-- name: MarketCreateStaleJobsUpdateRepo :exec
UPDATE "Repository"
SET "pendingSyncSha" = sqlc.arg('pendingSyncSha'), "updatedAt" = now()
WHERE id = sqlc.arg('id');
