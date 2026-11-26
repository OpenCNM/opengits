-- name: ClaimNextQueuedJobs :many
update "ImportJob" AS j
SET "status" = 'RUNNING',
    "lastHeartbeatAt" = NOW(),
    "startedAt" = COALESCE("startedAt", NOW()),
    "updatedAt" = NOW()
WHERE j."id" IN (
  SELECT q."id"
  FROM "ImportJob" q
  WHERE q."status" = 'QUEUED'
    AND (CARDINALITY($1::text[]) = 0 OR q."id"::text <> ALL($1::text[]))
  ORDER BY q."createdAt" ASC
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
RETURNING j."id";

-- name: ReapStaleImportJobs :execrows
update "ImportJob"
SET "status" = 'FAILED',
    "error" = $1,
    "finishedAt" = now(),
    "updatedAt" = now()
WHERE "status" = 'RUNNING'
  AND ("lastHeartbeatAt" IS NULL OR "lastHeartbeatAt" < $2);

-- name: GcFinishedImportJobs :execrows
DELETE FROM "ImportJob"
WHERE "status" IN ('COMPLETED', 'FAILED') AND "finishedAt" < $1
  AND COALESCE(result->>'importRewardPending', 'false') <> 'true'
  AND NOT (
    "status" = 'COMPLETED' AND NULLIF(result->>'repositoryId', '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "CreditGrantLedger" l
      WHERE l."repositoryId" = result->>'repositoryId' AND l.source = 'IMPORT_REWARD'
    )
  );

-- name: FailImportJob :execrows
update "ImportJob"
SET "status" = 'FAILED', "error" = $1, "finishedAt" = now(),
    "lastHeartbeatAt" = now(), "updatedAt" = now()
WHERE "id" = $2 AND "status" = 'RUNNING';

-- name: GetImportJob :one
SELECT id, owner, repo, branch, "userId", params, status
FROM "ImportJob"
WHERE id = $1;

-- name: HeartbeatImportJob :exec
update "ImportJob"
SET "lastHeartbeatAt" = NOW()
WHERE "id" = $1;

-- name: ClaimPendingImportRewardJobs :many
update "ImportJob" AS j SET "lastHeartbeatAt" = now()
WHERE j.id IN (
 SELECT q.id FROM "ImportJob" q
 WHERE q.status = 'COMPLETED' AND q.result->>'importRewardPending' = 'true'
  AND (q."lastHeartbeatAt" IS NULL OR q."lastHeartbeatAt" < $2)
 ORDER BY q."lastHeartbeatAt" ASC NULLS FIRST, q.id
 LIMIT $1 FOR UPDATE SKIP LOCKED
) RETURNING j.id;

-- name: UpdateImportJobProgress :exec
update "ImportJob"
SET "options" = jsonb_set(
    CASE WHEN "options" IS NULL OR jsonb_typeof("options") != 'object' THEN '{}'::jsonb ELSE "options" END,
    '{progressInfo}',
    $1::jsonb
),
    "updatedAt" = now()
WHERE "id" = $2;

-- name: FindActiveImportJob :one
SELECT "id" FROM "ImportJob"
WHERE "owner" = $1 AND "repo" = $2 AND "branch" = $3 AND "edition" = COALESCE(NULLIF($4, ''), '') AND "userId" = $5
  AND "status" IN ('QUEUED', 'RUNNING')
ORDER BY "createdAt" DESC
LIMIT 1;

-- name: CreateImportJob :one
INSERT INTO "ImportJob" ("id", "owner", "repo", "branch", "edition", "userId", "params", "status", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, $2, $3, COALESCE(NULLIF($4, ''), ''), $5, $6::jsonb, 'QUEUED', now(), now())
RETURNING "id";

-- name: CompleteImportJob :execrows
update "ImportJob"
SET "status" = 'COMPLETED',
    "finishedAt" = now(),
    "lastHeartbeatAt" = now(),
    "result" = $1::jsonb,
    "updatedAt" = now()
WHERE "id" = $2 AND "status" = 'RUNNING';

-- name: RequestImportPublication :exec
update "ImportJob"
SET "params" = jsonb_set(COALESCE("params", '{}'::jsonb), '{publishRequested}', 'true'::jsonb),
    "updatedAt" = now()
WHERE id = (
    SELECT sub.id FROM "ImportJob" AS sub
    WHERE sub."userId" = $1
      AND sub."status" = 'COMPLETED'
      AND sub."result"->>'repositoryId' = $2::text
      AND COALESCE(sub."params"->>'kind', '') <> 'web-sync'
    ORDER BY sub."createdAt" ASC, sub.id ASC
    LIMIT 1
);

-- name: InsertJobEvents :exec
-- 事件批量落库（unnest 多行单语句，替代事务内逐条循环）；
-- 保留 ON CONFLICT DO NOTHING 幂等重放语义（对语句内重复 seq 同样安全）。
INSERT INTO "ImportJobEvent" ("id", "jobId", "seq", "type", "payload", "createdAt")
SELECT
    gen_random_uuid()::text,
    @job_id::text,
    u.seq,
    u.type,
    u.payload,
    NOW()
FROM (
    SELECT
        unnest(@seqs::int[]) AS seq,
        unnest(@types::text[]) AS type,
        unnest(@payloads::jsonb[]) AS payload
) AS u
ON CONFLICT ("jobId", "seq") DO NOTHING;

-- name: GetEmergencyReadOnly :one
SELECT "emergencyReadOnly" FROM "GatewayPolicyConfig" WHERE id = 'singleton';

-- name: LoadCreditsConfig :one
SELECT "defaultDailyCredits", "resetIntervalHours", "maxCreditsPerImport",
       "codePedagogyMultiplier",
       "standardChunkCharSize", "publishGiftEnabled",
       "contributionVestingDays", "initialPublishRewardRatio"
FROM "PlatformCreditsConfig" WHERE id = 'singleton';

-- name: GetUserTierRole :one
SELECT tier, role FROM "User" WHERE id = $1;

-- name: GetUserTierRoleForUpdate :one
SELECT tier, role FROM "User" WHERE id = $1 FOR UPDATE;

-- name: UpsertSavedRepo :exec
INSERT INTO "SavedRepo" (id, "userId", "repositoryId", "autoFollow", "paidCredits", "createdAt")
VALUES (gen_random_uuid()::text, $1, $2, true, $3, now())
ON CONFLICT ("userId", "repositoryId") DO NOTHING;

-- name: GetSettleJob :one
SELECT "userId", owner, repo, status, COALESCE(params::text, '{}')::text AS params
FROM "ImportJob" WHERE id = $1;

-- name: GetChapterBaseCreditsSince :one
SELECT COALESCE(SUM("baseCredits"), 0)::float8 AS total
FROM "ChapterUpdateJob"
WHERE "claimedBy" = $1 AND status IN ('TRIAL','SWAPPED','REJECTED')
  AND "updatedAt" >= $2;

-- name: GetLedgerAmountSince :one
SELECT COALESCE(SUM(amount), 0)::float8 AS total FROM "CreditGrantLedger"
WHERE "userId" = $1 AND "createdAt" >= $2;

-- name: GetImportAmountSince :one
SELECT COALESCE(SUM(CASE WHEN (result->>'rewardCredits') ~ '^[0-9]+(\.[0-9]+)?$' THEN (result->>'rewardCredits')::numeric ELSE 0 END), 0)::float8 AS total
FROM "ImportJob"
WHERE "userId" = $1 AND status = 'COMPLETED' AND "updatedAt" >= $2;

-- name: GetRepoForPublishGift :one
SELECT "isPublic", "publishGiftAt", owner, repo, branch, edition
FROM "Repository" WHERE id = $1;

-- name: GetRecipientForPublishGift :one
SELECT "userId" FROM "ImportRecord" WHERE "repositoryId" = $1
ORDER BY "createdAt" ASC LIMIT 1;

-- name: GetPublishGiftAmount :one
-- 发布礼金聚合（SQL 下沉替代全量 params/result JSON 拉取；行级语义与
-- Go 版一致：actualCredits 非 0 取之，否则取 frozenCredits）。
SELECT COALESCE(SUM(
	COALESCE(
		NULLIF(CASE WHEN (result->>'actualCredits') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (result->>'actualCredits')::float8 ELSE 0 END, 0),
		CASE WHEN (params->>'frozenCredits') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (params->>'frozenCredits')::float8 ELSE 0 END)
), 0)::float8 AS amount
FROM "ImportJob"
WHERE "userId" = $1 AND owner = $2 AND repo = $3 AND branch = $4 AND edition = $5 AND status = 'COMPLETED';

-- name: MarkRepoPublishGiftAt :execrows
UPDATE "Repository" SET "publishGiftAt" = now(), "updatedAt" = now()
WHERE id = $1 AND "publishGiftAt" IS NULL;

-- name: AddUserCreditBalance :exec
UPDATE "User" SET "creditBalance" = COALESCE("creditBalance",0) + $1 WHERE id = $2;

-- name: InsertCreditGrantLedgerPublishGift :exec
INSERT INTO "CreditGrantLedger" (id, "userId", source, amount, "repositoryId", "createdAt")
VALUES (gen_random_uuid()::text, $1, 'PUBLISH_GIFT', $2, $3, now());

-- name: InsertNotificationPublishGift :exec
INSERT INTO "Notification" (id, "userId", type, title, body, payload, "createdAt")
VALUES (gen_random_uuid()::text, @user_id, 'tutorial_published', @title, @body, @payload::jsonb, now());
