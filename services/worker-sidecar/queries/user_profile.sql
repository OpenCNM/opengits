-- name: GetUserPreferences :one
SELECT "preferredLang1", "preferredLang2", "preferredLang3",
       "industry", "primaryProgLang", "secondaryProgLang",
       "fontSize", "hasPreferencesSet", "disabledMcpRepoIds"
FROM "User"
WHERE "id" = $1;

-- name: GetSavedRepositoriesOverview :many
SELECT r."id", r."owner", r."repo", r."mcpStatus",
       COUNT(d."id")::bigint AS total_docs,
       COUNT(d."id") FILTER (WHERE d."status" = 'PROCESSED')::bigint AS processed_docs
FROM "SavedRepo" sr
JOIN "Repository" r ON r."id" = sr."repositoryId"
LEFT JOIN "Document" d ON d."repositoryId" = r."id"
WHERE sr."userId" = $1
GROUP BY r."id", r."owner", r."repo", r."mcpStatus", sr."createdAt"
ORDER BY sr."createdAt" DESC;

-- name: GetUserUsageSummary :one
SELECT "tier", "role", "dailyMcpQuota"
FROM "User"
WHERE "id" = $1;

-- name: CountUserSavedRepos :one
SELECT COUNT(*)::bigint
FROM "SavedRepo"
WHERE "userId" = $1;

-- name: GetUserMcpCallsToday :one
SELECT "mcpCalls"
FROM "McpUsageLedger"
WHERE "userId" = $1 AND "day" = $2;

-- name: GetUserTokens30d :one
SELECT COALESCE(SUM("totalTokens"), 0)::bigint
FROM "TokenUsageLog"
WHERE "userId" = $1 AND "createdAt" >= $2;

-- name: SetUserPreferences :one
INSERT INTO "User" (
    "id", "preferredLang1", "preferredLang2", "preferredLang3",
    "industry", "primaryProgLang", "secondaryProgLang",
    "fontSize", "hasPreferencesSet", "disabledMcpRepoIds"
) VALUES (
    $1, $2, $3, $4,
    $5, $6, $7,
    $8, true, $9
)
ON CONFLICT ("id") DO UPDATE SET
    "preferredLang1" = EXCLUDED."preferredLang1",
    "preferredLang2" = EXCLUDED."preferredLang2",
    "preferredLang3" = EXCLUDED."preferredLang3",
    "industry" = EXCLUDED."industry",
    "primaryProgLang" = EXCLUDED."primaryProgLang",
    "secondaryProgLang" = EXCLUDED."secondaryProgLang",
    "fontSize" = EXCLUDED."fontSize",
    "hasPreferencesSet" = true,
    "disabledMcpRepoIds" = CASE WHEN $10::boolean THEN EXCLUDED."disabledMcpRepoIds" ELSE "User"."disabledMcpRepoIds" END
RETURNING "id", "name", "email", "image", "role", "tier",
          "preferredLang1", "preferredLang2", "preferredLang3",
          "industry", "primaryProgLang", "secondaryProgLang",
          "fontSize", "hasPreferencesSet", "disabledMcpRepoIds";

-- name: UnsaveRepo :execrows
DELETE FROM "SavedRepo"
WHERE "userId" = $1 AND "repositoryId" = $2;

-- name: SetSavedRepoFollow :execrows
UPDATE "SavedRepo"
SET "autoFollow" = $3
WHERE "userId" = $1 AND "repositoryId" = $2;

-- name: GetUserPinnedReposForUpdate :one
SELECT "pinnedRepoIds"
FROM "User"
WHERE "id" = $1
FOR UPDATE;

-- name: UpdateUserPinnedRepos :exec
UPDATE "User"
SET "pinnedRepoIds" = $1
WHERE "id" = $2;

-- name: GetRepoForReadingProgress :one
SELECT "id", "owner", "repo"
FROM "Repository"
WHERE LOWER("owner") = LOWER($1) AND LOWER("repo") = LOWER($2)
LIMIT 1;

-- name: GetRepoForReadingProgressWithEdition :one
SELECT "id", "owner", "repo"
FROM "Repository"
WHERE LOWER("owner") = LOWER($1) AND LOWER("repo") = LOWER($2) AND "edition" = $3
LIMIT 1;

-- name: GetRepoDocumentsForProgress :many
SELECT "path", "status"::text AS "status"
FROM "Document"
WHERE "repositoryId" = $1;

-- name: GetUserReadingProgressByRepo :one
SELECT "lastReadPath", "updatedAt"
FROM "UserReadingProgress"
WHERE "userId" = $1 AND "repositoryId" = $2
LIMIT 1;

-- name: GetEpisodicEventsForUserRepo :many
SELECT "eventType", "pageUrl", "duration", "metadata"
FROM "EpisodicEvent"
WHERE "userId" = $1
  AND "repositoryId" = $2
  AND "createdAt" >= $3
ORDER BY "createdAt" DESC
LIMIT 10000;

-- name: ListMcpTokensByUserID :many
SELECT "id", "name", "prefix", "lastUsedAt", "createdAt", "revokedAt"
FROM "McpApiToken"
WHERE "userId" = $1
ORDER BY "createdAt" DESC;

-- name: CountActiveMcpTokensByUserID :one
SELECT COUNT(*)::bigint
FROM "McpApiToken"
WHERE "userId" = $1 AND "revokedAt" IS NULL;

-- name: CreateMcpToken :one
INSERT INTO "McpApiToken" ("id", "userId", "name", "tokenHash", "encryptedToken", "prefix", "createdAt")
VALUES ($1, $2, $3, $4, $5, $6, NOW())
RETURNING "id", "name", "prefix", "createdAt";

-- name: RevokeAllMcpTokens :execrows
UPDATE "McpApiToken"
SET "revokedAt" = NOW()
WHERE "userId" = $1 AND "revokedAt" IS NULL;

-- name: RevokeMcpTokenByID :execrows
UPDATE "McpApiToken"
SET "revokedAt" = NOW()
WHERE "id" = $1 AND "userId" = $2 AND "revokedAt" IS NULL;

-- name: TouchMcpTokenUsage :exec
UPDATE "McpApiToken"
SET "lastUsedAt" = NOW()
WHERE "id" = $1;

-- name: IncrementRepoViews :exec
UPDATE "Repository" SET "views" = "views" + 1 WHERE "id" = $1;

-- name: GetRepoIDsByOwnerList :many
SELECT "id", LOWER("owner")::text AS "owner", LOWER("repo")::text AS "repo"
FROM "Repository"
WHERE LOWER("owner") = ANY($1::text[]);

-- name: InsertEpisodicEvent :exec
INSERT INTO "EpisodicEvent" ("id", "userId", "pageUrl", "eventType", "targetId", "duration", "metadata", "repositoryId", "createdAt")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW());

-- name: InsertEpisodicEvents :exec
-- 遥测批量写入（unnest 多行单语句，一次往返替代每批 ≤50 次串行往返）；
-- 单行数据病态导致整语句失败时，由调用方回退逐行重放保容错计数语义。
INSERT INTO "EpisodicEvent" ("id", "userId", "pageUrl", "eventType", "targetId", "duration", "metadata", "repositoryId", "createdAt")
SELECT
    u.id,
    @user_id::text,
    u.page_url,
    u.event_type,
    NULLIF(u.target_id, ''),
    NULLIF(u.duration, '')::int4,
    u.metadata,
    NULLIF(u.repository_id, ''),
    NOW()
FROM (
    SELECT
        unnest(@ids::text[]) AS id,
        unnest(@page_urls::text[]) AS page_url,
        unnest(@event_types::text[]) AS event_type,
        unnest(@target_ids::text[]) AS target_id,
        unnest(@durations::text[]) AS duration,
        unnest(@metas::jsonb[]) AS metadata,
        unnest(@repository_ids::text[]) AS repository_id
) AS u;
