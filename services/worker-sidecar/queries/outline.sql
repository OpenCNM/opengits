-- name: GetActiveOutlineByRepoID :one
SELECT "id", "version", "mode"
FROM "TutorialOutline"
WHERE "repositoryId" = $1 AND "isActive" = TRUE
ORDER BY "version" DESC
LIMIT 1;

-- name: GetOutlinePartsByOutlineID :many
SELECT "id", "title", "summary", "teachingOrder"
FROM "OutlinePart"
WHERE "outlineId" = $1
ORDER BY "teachingOrder" ASC;

-- name: GetOutlineChaptersByOutlineID :many
SELECT "id", "partId", "title", "summary", "chapterType", "moduleName", "teachingOrder"
FROM "OutlineChapter"
WHERE "outlineId" = $1
ORDER BY "teachingOrder" ASC;

-- name: GetOutlineNodesByChapterIDs :many
SELECT n."id", n."chapterId", n."title", n."nodeType", n."headingPath", n."documentId", d."path" AS "docPath", d."status" AS "docStatus", n."teachingOrder"
FROM "OutlineNode" n
LEFT JOIN "Document" d ON d."id" = n."documentId"
WHERE n."chapterId" = ANY($1::text[])
ORDER BY n."teachingOrder" ASC;

-- name: GetRepositoryHelpfulCount :one
SELECT "helpfulCount" FROM "Repository" WHERE "id" = $1 FOR UPDATE;

-- name: GetHelpfulVote :one
SELECT "id" FROM "HelpfulVote" WHERE "repositoryId" = $1 AND "userId" = $2;

-- name: DeleteHelpfulVote :exec
DELETE FROM "HelpfulVote" WHERE "id" = $1;

-- name: DecrementRepositoryHelpfulCount :one
UPDATE "Repository" SET "helpfulCount" = GREATEST(0, "helpfulCount" - 1) WHERE "id" = $1 RETURNING "helpfulCount";

-- name: InsertHelpfulVote :exec
INSERT INTO "HelpfulVote" ("id", "repositoryId", "userId", "createdAt") VALUES ($1, $2, $3, $4);

-- name: IncrementRepositoryHelpfulCount :one
UPDATE "Repository" SET "helpfulCount" = "helpfulCount" + 1 WHERE "id" = $1 RETURNING "helpfulCount";

-- name: GetDocumentStatusWithJob :one
SELECT d."status", d."errorMessage", j."options"
FROM "Document" d
LEFT JOIN "TranscriptionJob" j ON j."documentId" = d."id"
WHERE d."id" = $1;

-- name: GetRepositoryForIngestStatus :one
SELECT 
    "id", "owner", "repo", "branch", "edition", "isPublic", NULL::text AS "ownerUserId",
    "transcriptionPaused", "reviewStatus", "publishedAt", "transcriptionCreditsEarned",
    COALESCE("transcriptionTokens", 0)::int AS "transcriptionTokens",
    COALESCE("repoProfile", '{}'::jsonb)::jsonb AS "repoProfile",
    COALESCE("navTree", '[]'::jsonb)::jsonb AS "navTree"
FROM "Repository"
WHERE "owner" = $1 AND "repo" = $2 AND "branch" = $3 AND "edition" = $4
ORDER BY "edition" ASC
LIMIT 1;

-- name: GetDocumentsWithTranscriptionJob :many
SELECT 
    d."id", d."path", d."title", d."status", d."errorMessage",
    tj."status" AS "jobStatus", tj."checkpointTotal", tj."checkpointChunks",
    tj."claimedAt" AS "jobClaimedAt", tj."createdAt" AS "jobCreatedAt"
FROM "Document" d
LEFT JOIN "TranscriptionJob" tj ON tj."documentId" = d."id"
WHERE d."repositoryId" = sqlc.arg('repositoryId')
    AND (
        sqlc.narg('userId')::text IS NULL AND d."ownerUserId" IS NULL
        OR sqlc.narg('userId')::text IS NOT NULL AND (d."ownerUserId" IS NULL OR d."ownerUserId" = sqlc.narg('userId')::text)
    )
ORDER BY d."path" ASC;

-- name: GetLatestImportJobParams :one
SELECT "params"
FROM "ImportJob"
WHERE "userId" = $1 AND "owner" = $2 AND "repo" = $3 AND "edition" = $4
ORDER BY "createdAt" DESC
LIMIT 1;

-- name: GetFeaturedRepos :many
SELECT r."id", r."owner", r."repo"
FROM "Repository" r
WHERE r."isPublic" = true
    AND EXISTS (
        SELECT 1 FROM "Document" d
        WHERE d."repositoryId" = r."id"
            AND d."status" = 'PROCESSED'
            AND d."ownerUserId" IS NULL
    )
ORDER BY r."views" DESC, r."starCount" DESC
LIMIT $1;

-- name: GetRepoPauseInfo :one
SELECT "id", "isPublic"
FROM "Repository"
WHERE "owner" = $1 AND "repo" = $2 AND "branch" = $3 AND "edition" = $4
LIMIT 1;

-- name: UpdateRepoTranscriptionPaused :exec
UPDATE "Repository" SET "transcriptionPaused" = $1 WHERE "id" = $2;

-- name: GetDocumentContentForReading :one
-- 读取规则对齐 prisma/schema.prisma Document.ownerUserId 注释：
-- null = 共享文档；非 null = 该用户私有冻结副本（他人不可读）。
-- Document 表没有 authorId/visibility 列（那是 ChapterVersion 的列），勿回退旧写法。
SELECT d."id", d."path", d."title", d."status", COALESCE(dc."content", d."content", '')::text AS content
FROM "Document" d
LEFT JOIN "DocumentContent" dc ON dc."id" = d."contentId"
WHERE d."repositoryId" = sqlc.arg('repositoryId')
  AND d."path" = ANY(sqlc.arg('candidatePaths')::text[])
  AND (
    d."ownerUserId" IS NULL
    OR (sqlc.narg('userId')::text IS NOT NULL AND d."ownerUserId" = sqlc.narg('userId')::text)
  )
ORDER BY array_position(sqlc.arg('candidatePaths')::text[], d."path")
LIMIT 1;
