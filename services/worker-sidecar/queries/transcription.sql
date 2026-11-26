-- name: ClearDocumentChunks :exec
DELETE FROM "DocumentChunk" WHERE "documentId" = $1;

-- name: GetDocumentChunkMeta :one
SELECT d.path, r."semVerLabel", r.branch
FROM "Document" d
JOIN "Repository" r ON r.id = d."repositoryId"
WHERE d.id = $1;



-- name: BatchInsertDocumentChunks :exec
INSERT INTO "DocumentChunk" (
    id, "documentId", "heading", "headingPath", "contentType", "content", "order", "updatedAt", "semVerLabel"
)
SELECT 
    gen_random_uuid()::text,
    @document_id::text,
    NULLIF(u.heading, ''),
    NULLIF(u.heading_path, ''),
    u.content_type,
    u.content,
    u.chunk_order,
    NOW(),
    NULLIF(@sem_ver_label::text, '')
FROM (
    SELECT 
        unnest(@headings::text[]) AS heading,
        unnest(@heading_paths::text[]) AS heading_path,
        unnest(@content_types::text[]) AS content_type,
        unnest(@contents::text[]) AS content,
        unnest(@chunk_orders::int[]) AS chunk_order
) AS u;

-- name: GetContentByHash :one
SELECT id, "requestFingerprint" FROM "DocumentContent" WHERE "contentHash" = $1;

-- name: UpdateContentRequestFingerprint :exec
UPDATE "DocumentContent" SET "requestFingerprint" = $1
WHERE id = $2 AND "requestFingerprint" IS NULL;

-- name: InsertContentLayer :execrows
INSERT INTO "DocumentContent" (id, "contentHash", "requestFingerprint", content, lang, "generationModel", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, NULLIF(@request_fingerprint::text, ''), $2, $3, NULLIF(@generation_model::text, ''), now(), now())
ON CONFLICT DO NOTHING;

-- name: GetContentIdByHash :one
SELECT id FROM "DocumentContent" WHERE "contentHash" = $1;

-- name: InsertContentLayerNoFingerprint :execrows
INSERT INTO "DocumentContent" (id, "contentHash", "requestFingerprint", content, lang, "generationModel", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, NULL, $2, $3, NULLIF(@generation_model::text, ''), now(), now())
ON CONFLICT DO NOTHING;

-- name: DeleteDocumentChunksByContentId :exec
DELETE FROM "DocumentChunk" WHERE "contentId" = $1;

-- name: TranscriptionCopyDocumentChunksToContent :exec
INSERT INTO "DocumentChunk" (id, "contentId", heading, "headingPath", "semVerLabel", "contentType", content, "order", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, @content_id::text, heading, "headingPath", "semVerLabel", "contentType", content, "order", now(), now()
FROM "DocumentChunk" WHERE "documentId" = @document_id::text
ORDER BY "order" ASC, "createdAt" ASC;

-- name: StampDocumentProcessed :execrows
UPDATE "Document" SET
  content = CASE WHEN @dual_write::boolean OR NULLIF(@content_id::text, '') IS NULL THEN @content::text ELSE NULL END,
  status = 'PROCESSED',
  "errorMessage" = NULL,
  "gitSha" = NULLIF(@git_sha::text, ''),
  "generationModel" = NULLIF(@generation_model::text, ''),
  "generationLevel" = COALESCE(NULLIF(@generation_level::text, ''), "generationLevel"),
  "contentId" = NULLIF(@content_id::text, ''),
  "updatedAt" = now()
WHERE id = @document_id::text
  AND (status = 'PROCESSING' OR status = 'UNPROCESSED' OR status = 'ERROR' OR "contentId" IS NULL);

-- name: RecordTranscriptionModel :exec
UPDATE "Repository"
SET "transcriptionModels" = (
  CASE WHEN @model::text = ANY("transcriptionModels")
    THEN "transcriptionModels"
    ELSE array_append("transcriptionModels", @model::text)
  END
), "updatedAt" = now()
WHERE id = @repository_id::text;

-- name: RecordTranscriptionTokens :exec
UPDATE "Repository" SET "transcriptionTokens" = COALESCE("transcriptionTokens", 0) + @tokens::int, "updatedAt" = now()
WHERE id = @repository_id::text;

-- name: ClearProcessingStatusError :exec
UPDATE "Document" SET status = 'ERROR', "errorMessage" = @message::text,
    "updatedAt" = now()
WHERE id = @document_id::text;

-- name: ClearProcessingStatus :exec
UPDATE "Document" SET status = @status::text, "updatedAt" = now() WHERE id = @document_id::text;

-- name: GetCheckpoint :one
SELECT "checkpointFingerprint", COALESCE("checkpointChunks", '{}'::jsonb)::jsonb AS checkpoint_chunks
FROM "TranscriptionJob" WHERE "documentId" = $1;

-- name: GetDocumentRepoTranscriptionStatus :one
SELECT 
  r.owner, 
  r.repo,
  COUNT(d2.id)::bigint AS total_count,
  COUNT(d2.id) FILTER (WHERE d2.status != 'PROCESSED')::bigint AS pending_count
FROM "Document" d
JOIN "Repository" r ON r.id = d."repositoryId"
LEFT JOIN "Document" d2 ON d2."repositoryId" = d."repositoryId" 
  AND ((d."ownerUserId" IS NULL AND d2."ownerUserId" IS NULL) OR d."ownerUserId" = d2."ownerUserId")
WHERE d.id = $1
GROUP BY r.owner, r.repo;

-- name: InsertTutorialTranscriptionNotification :execrows
INSERT INTO "Notification" (id, "userId", type, title, body, payload, "createdAt")
SELECT
    gen_random_uuid()::text,
    @user_id::text,
    'transcription_done',
    '教程转录完成',
    @body::text,
    jsonb_build_object('owner', @owner::text, 'repo', @repo::text),
    now()
WHERE NOT EXISTS (
    SELECT 1 FROM "Notification"
    WHERE "userId" = @user_id::text
      AND type = 'transcription_done'
      AND payload->>'owner' = @owner::text
      AND payload->>'repo' = @repo::text
      AND "createdAt" > now() - INTERVAL '10 minutes'
);

-- name: InsertTutorialTranscriptionFailedNotification :execrows
-- 报忧通知（对齐 Node notifyTranscriptionFailed 的 payload/标题/10 分钟防抖；
-- Node 队列消费循环退役后，通知收敛到 Go 单写者——FailTranscriptionJobExhausted
-- 终态分支触发）。
INSERT INTO "Notification" (id, "userId", type, title, body, payload, "createdAt")
SELECT
    gen_random_uuid()::text,
    j."requestedBy",
    'transcription_failed',
    '教程转录中断',
    j.repo_owner || '/' || j.repo_name || ' · 遇到异常已暂停',
    jsonb_build_object('owner', j.repo_owner, 'repo', j.repo_name, 'path', j.doc_path, 'error', @message::text),
    now()
FROM (
    SELECT tj."requestedBy", r."owner" AS repo_owner, r."repo" AS repo_name, d."path" AS doc_path
    FROM "TranscriptionJob" tj
    JOIN "Document" d ON d.id = tj."documentId"
    JOIN "Repository" r ON r.id = d."repositoryId"
    WHERE tj."id" = @job_id::text
) j
WHERE NOT EXISTS (
    SELECT 1 FROM "Notification" n
    WHERE n."userId" = j."requestedBy"
      AND n.type = 'transcription_failed'
      AND n.payload->>'owner' = j.repo_owner
      AND n.payload->>'repo' = j.repo_name
      AND n."createdAt" > now() - INTERVAL '10 minutes'
);

-- name: GetUpstreamChapterPrecedents :many
SELECT COALESCE(d."title", d."path")::text AS doc_title,
       COALESCE(d."summary", '')::text AS doc_summary,
       COALESCE(array_agg(DISTINCT n."conceptName") FILTER (WHERE n."conceptName" IS NOT NULL), ARRAY[]::text[])::text[] AS concepts,
       d."path"::text AS doc_path
FROM "Document" d
LEFT JOIN "TutorialConceptNode" n ON n."documentId" = d."id"
WHERE d."repositoryId" = $1
  AND d."ownerUserId" IS NULL
  AND d."status" = 'PROCESSED'
GROUP BY d."id", d."title", d."path", d."summary", d."createdAt"
ORDER BY d."createdAt" ASC
LIMIT 16;

-- name: TranscriptionCasProcessing :execrows
UPDATE "Document" SET status = 'PROCESSING', "errorMessage" = NULL, "updatedAt" = now()
WHERE id = @document_id::text AND status::text = ANY(@sources::text[]);

-- name: TranscriptionHeartbeatDocument :exec
WITH upd_doc AS (
    UPDATE "Document" SET "updatedAt" = now() WHERE id = $1 RETURNING id
)
update "TranscriptionJob" SET "updatedAt" = now()
WHERE "documentId" = $1 AND "status" = 'RUNNING';

-- name: TranscriptionCheckpointSave :exec
INSERT INTO "TranscriptionJob"
  ("id", "documentId", "requestedBy", "priority", "status", "claimedAt",
   "checkpointFingerprint", "checkpointChunks", "checkpointTotal")
VALUES (
  gen_random_uuid()::text, @document_id::text, @requested_by::text, 0, 'RUNNING', NOW(),
  @fingerprint::text, jsonb_build_object(@key::text, to_jsonb(@content::text)), @total::int)
ON CONFLICT ("documentId") DO update SET
  "checkpointFingerprint" = @fingerprint::text,
  "checkpointTotal" = @total::int,
  "checkpointChunks" =
    CASE WHEN "TranscriptionJob"."checkpointFingerprint" = @fingerprint::text
      THEN COALESCE("TranscriptionJob"."checkpointChunks", '{}'::jsonb) || jsonb_build_object(@key::text, to_jsonb(@content::text))
      ELSE jsonb_build_object(@key::text, to_jsonb(@content::text))
    END;

-- name: TranscriptionClearCheckpoint :exec
update "TranscriptionJob" SET "checkpointFingerprint" = NULL, "checkpointChunks" = NULL, "checkpointTotal" = NULL
WHERE "documentId" = $1;

-- name: TranscriptionUpdateProgress :exec
update "TranscriptionJob"
SET "options" = jsonb_set(
    CASE WHEN "options" IS NULL OR jsonb_typeof("options") != 'object' THEN '{}'::jsonb ELSE "options" END,
    '{progressInfo}',
    @payload::jsonb
),
    "updatedAt" = now()
WHERE "documentId" = @document_id::text;

-- name: TranscriptionUpdateDocumentSummary :exec
UPDATE "Document" SET summary = $1, "updatedAt" = now() WHERE id = $2;

-- name: TranscriptionGetDocumentRepositoryInfo :one
SELECT d."repositoryId", d.path, COALESCE(r.branch, '')::text AS branch
FROM "Document" d
JOIN "Repository" r ON r.id = d."repositoryId"
WHERE d.id = $1;

-- name: TranscriptionCompleteJob :exec
update "TranscriptionJob"
SET "status" = 'DONE', "finishedAt" = now(), "lastError" = NULL,
    "checkpointChunks" = NULL, "checkpointTotal" = NULL, "updatedAt" = now()
WHERE "id" = $1 AND "status" = 'RUNNING';

-- name: TranscriptionClaimNextJobs :many
WITH candidates AS (
  SELECT q."id",
         ROW_NUMBER() OVER (PARTITION BY d."repositoryId" ORDER BY q."createdAt" ASC) as repo_rank
  FROM "TranscriptionJob" q
  JOIN "Document" d ON d.id = q."documentId"
  JOIN "Repository" r ON r.id = d."repositoryId"
  WHERE q."status" = 'QUEUED'
    AND r."transcriptionPaused" = false
  ORDER BY
    q."priority" + (EXTRACT(EPOCH FROM (NOW() - q."createdAt")) / 60)::int DESC,
    repo_rank ASC,
    q."createdAt" ASC
  LIMIT $1
)
update "TranscriptionJob" AS j
SET "status" = 'RUNNING',
    "claimedAt" = NOW(),
    "updatedAt" = NOW()
WHERE j."status" = 'QUEUED'
  AND j."id" IN (
    SELECT q."id"
    FROM "TranscriptionJob" q
    WHERE q."id" IN (SELECT id FROM candidates)
    FOR UPDATE OF q SKIP LOCKED
  )
RETURNING j."id", j."documentId", j."requestedBy", j."options";

-- name: TranscriptionReapStaleJobs :one
WITH stale_jobs AS (
    SELECT "TranscriptionJob".id, "TranscriptionJob"."documentId", "TranscriptionJob".attempts
    FROM "TranscriptionJob"
    WHERE "TranscriptionJob"."status" = 'RUNNING'
      AND COALESCE("TranscriptionJob"."updatedAt", "TranscriptionJob"."claimedAt") < $1
),
requeued_jobs AS (
    update "TranscriptionJob"
    SET "status" = 'QUEUED',
        attempts = "TranscriptionJob".attempts + 1,
        "claimedAt" = NULL,
        "updatedAt" = now()
    FROM stale_jobs s
    WHERE "TranscriptionJob".id = s.id
      AND "TranscriptionJob"."status" = 'RUNNING'
      AND s.attempts + 1 < 3
    RETURNING "TranscriptionJob".id
),
failed_jobs AS (
    update "TranscriptionJob"
    SET "status" = 'FAILED',
        attempts = "TranscriptionJob".attempts + 1,
        "lastError" = 'Stale execution lease expired (exceeded 3 retry attempts)',
        "finishedAt" = now(),
        "updatedAt" = now()
    FROM stale_jobs s
    WHERE "TranscriptionJob".id = s.id
      AND "TranscriptionJob"."status" = 'RUNNING'
      AND s.attempts + 1 >= 3
    RETURNING "TranscriptionJob".id, "TranscriptionJob"."documentId"
),
failed_docs AS (
    UPDATE "Document"
    SET status = 'ERROR',
        "errorMessage" = 'Transcription job timed out after 3 retry attempts',
        "updatedAt" = now()
    FROM failed_jobs f
    WHERE "Document".id = f."documentId"
      AND "Document".status != 'PROCESSED'
    RETURNING "Document".id
)
SELECT ((SELECT count(*) FROM requeued_jobs) + (SELECT count(*) FROM failed_jobs))::bigint;

-- name: TranscriptionDeferJob :execrows
update "TranscriptionJob"
SET "status" = 'QUEUED', "claimedAt" = NULL,
    "createdAt" = NOW(), "updatedAt" = NOW()
WHERE "id" = $1 AND "status" = 'RUNNING';

-- name: TranscriptionFailJobExhausted :execrows
update "TranscriptionJob"
SET "status" = 'FAILED', attempts = attempts + 1,
    "lastError" = left(@message::text, 500), "finishedAt" = now(), "updatedAt" = now()
WHERE "id" = @id::text AND "status" = 'RUNNING'
  AND attempts + 1 >= 3;

-- name: TranscriptionFailJobImmediate :execrows
update "TranscriptionJob"
SET "status" = 'FAILED', attempts = attempts + 1,
    "lastError" = left(@message::text, 500), "finishedAt" = now(), "updatedAt" = now()
WHERE "id" = @id::text AND "status" = 'RUNNING';

-- name: TranscriptionSetDocErrorExhausted :exec
UPDATE "Document"
SET status = 'ERROR', "errorMessage" = left(@message::text, 500), "updatedAt" = now()
WHERE id = (SELECT "documentId" FROM "TranscriptionJob" WHERE id = @id::text)
  AND status = 'PROCESSING';

-- name: TranscriptionFailJobRequeue :execrows
update "TranscriptionJob"
SET "status" = 'QUEUED', attempts = attempts + 1,
    "lastError" = left(@message::text, 500), "updatedAt" = now()
WHERE "id" = @id::text AND "status" = 'RUNNING';

-- name: TranscriptionEmergencyReadOnly :one
SELECT "emergencyReadOnly" FROM "GatewayPolicyConfig" WHERE id = 'singleton';

-- name: TranscriptionRuntimePolicy :one
SELECT
  "emergencyReadOnly",
  "transcriptionConcurrency",
  "transcriptionChunkConcurrency"
FROM "GatewayPolicyConfig"
WHERE id = 'singleton';

-- name: TranscriptionGetJobStatus :one
SELECT id, "status" FROM "TranscriptionJob"
WHERE "documentId" = $1;

-- name: TranscriptionResetJob :exec
update "TranscriptionJob"
SET "status" = 'QUEUED', "priority" = @priority::int, "lastError" = NULL, "finishedAt" = NULL,
    "checkpointChunks" = NULL, "checkpointTotal" = NULL, "checkpointFingerprint" = NULL,
    "attempts" = 0, "options" = @options::jsonb, "updatedAt" = now()
WHERE "id" = @id::text AND "status" = @from_status::text;

-- name: TranscriptionInsertJob :exec
INSERT INTO "TranscriptionJob" ("id", "documentId", "requestedBy", "priority", "status", "options", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, @document_id::text, @requested_by::text, @priority::int, 'QUEUED', @options::jsonb, now(), now())
ON CONFLICT ("documentId") DO NOTHING;

-- name: TranscriptionBatchEnqueueJobs :execrows
INSERT INTO "TranscriptionJob" (
  "id", "documentId", "requestedBy", "priority", "status", "options", "createdAt", "updatedAt"
)
SELECT 
  gen_random_uuid()::text,
  d.id,
  @requested_by::text,
  GREATEST(0, 10000 - (ROW_NUMBER() OVER (ORDER BY d."createdAt" ASC, d."path" ASC)) * 20)::int,
  'QUEUED',
  COALESCE(@options::jsonb, '{}'::jsonb),
  NOW(),
  NOW()
FROM "Document" d
WHERE d."repositoryId" = @repository_id::text
  AND d.status = 'UNPROCESSED'
ON CONFLICT ("documentId") DO UPDATE SET
  "status" = CASE WHEN "TranscriptionJob"."status" = 'RUNNING' THEN "TranscriptionJob"."status" ELSE 'QUEUED' END,
  "priority" = CASE WHEN "TranscriptionJob"."status" = 'RUNNING' THEN "TranscriptionJob"."priority" ELSE EXCLUDED."priority" END,
  "options" = CASE WHEN "TranscriptionJob"."status" = 'RUNNING' THEN "TranscriptionJob"."options" ELSE EXCLUDED."options" END,
  "lastError" = CASE WHEN "TranscriptionJob"."status" = 'RUNNING' THEN "TranscriptionJob"."lastError" ELSE NULL END,
  "finishedAt" = CASE WHEN "TranscriptionJob"."status" = 'RUNNING' THEN "TranscriptionJob"."finishedAt" ELSE NULL END,
  "updatedAt" = NOW();

-- name: TranscriptionListActiveQueue :many
-- 排队快照（只读，无锁）：与 TranscriptionClaimNextJobs 同口径的有效优先级排序与
-- 仓级暂停过滤，供 ingest-status 计算每个 QUEUED 任务的排队位置。
WITH ranked_queue AS (
  SELECT q."id", q."documentId",
         q."priority" + (EXTRACT(EPOCH FROM (NOW() - q."createdAt")) / 60)::int AS effective_priority,
         ROW_NUMBER() OVER (PARTITION BY d."repositoryId" ORDER BY q."createdAt" ASC) AS repo_rank,
         q."createdAt"
  FROM "TranscriptionJob" q
  JOIN "Document" d ON d.id = q."documentId"
  JOIN "Repository" r ON r.id = d."repositoryId"
  WHERE q."status" = 'QUEUED'
    AND r."transcriptionPaused" = false
)
SELECT "id", "documentId"
FROM ranked_queue
ORDER BY
  effective_priority DESC,
  repo_rank ASC,
  "createdAt" ASC;

-- name: TranscriptionRecentAvgJobSeconds :one
-- 最近 20 个 DONE 任务的平均执行耗时（claimedAt→finishedAt 秒）；无历史返回 -1 哨兵。
SELECT COALESCE(
  AVG(EXTRACT(EPOCH FROM (j."finishedAt" - j."claimedAt"))),
  -1
)::float8
FROM (
  SELECT "finishedAt", "claimedAt"
  FROM "TranscriptionJob"
  WHERE "status" = 'DONE' AND "finishedAt" IS NOT NULL AND "claimedAt" IS NOT NULL
  ORDER BY "finishedAt" DESC
  LIMIT 20
) j;

-- name: TranscriptionPrioritizeJob :execrows
INSERT INTO "TranscriptionJob" (
  "id", "documentId", "requestedBy", "priority", "status", "options", "createdAt", "updatedAt"
)
VALUES (
  gen_random_uuid()::text, @document_id::text, @requested_by::text, @priority::int, 'QUEUED', '{}'::jsonb, NOW(), NOW()
)
ON CONFLICT ("documentId") DO UPDATE SET
  "priority" = CASE 
    WHEN "TranscriptionJob"."status" = 'RUNNING' THEN "TranscriptionJob"."priority"
    WHEN "TranscriptionJob"."status" = 'QUEUED' THEN GREATEST("TranscriptionJob"."priority", EXCLUDED."priority")
    ELSE EXCLUDED."priority"
  END,
  "status" = CASE 
    WHEN "TranscriptionJob"."status" = 'RUNNING' THEN 'RUNNING'
    ELSE 'QUEUED'
  END,
  "lastError" = CASE 
    WHEN "TranscriptionJob"."status" = 'RUNNING' THEN "TranscriptionJob"."lastError"
    ELSE NULL
  END,
  "finishedAt" = CASE 
    WHEN "TranscriptionJob"."status" = 'RUNNING' THEN "TranscriptionJob"."finishedAt"
    ELSE NULL
  END,
  "updatedAt" = CASE 
    WHEN "TranscriptionJob"."status" = 'RUNNING' THEN "TranscriptionJob"."updatedAt"
    ELSE NOW()
  END;



-- name: SyncDocumentTitleFromTranscription :exec
UPDATE "Document" SET title = @title::text, "updatedAt" = now()
WHERE id = @document_id::text;

-- name: SyncOutlineNodeTitleFromTranscription :execrows
UPDATE "OutlineNode" SET title = @title::text
WHERE "documentId" = @document_id::text AND title IS DISTINCT FROM @title::text;
