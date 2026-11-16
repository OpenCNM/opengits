-- name: GetChapterVersionForVote :one
SELECT cv."id", cv."documentId", cv."authorId", cv."visibility", cv."voteCount", r."id" AS repo_id, r."isPublic"
FROM "ChapterVersion" cv
JOIN "Document" d ON d."id" = cv."documentId"
JOIN "Repository" r ON r."id" = d."repositoryId"
WHERE cv."id" = $1;

-- name: CheckSavedRepoAccess :one
SELECT 1 FROM "SavedRepo" WHERE "repositoryId" = $1 AND "userId" = $2 LIMIT 1;

-- name: ToggleChapterVersionVoteAtomic :one
WITH deleted AS (
  DELETE FROM "ChapterVersionVote" cvv
  WHERE cvv."versionId" = sqlc.arg('versionId') AND cvv."userId" = sqlc.arg('userId')
  RETURNING cvv."id"
),
inserted AS (
  INSERT INTO "ChapterVersionVote" ("id", "versionId", "userId", "createdAt")
  SELECT sqlc.arg('voteId')::text, sqlc.arg('versionId')::text, sqlc.arg('userId')::text, NOW()
  WHERE NOT EXISTS (SELECT 1 FROM deleted)
  RETURNING "id"
),
updated AS (
  UPDATE "ChapterVersion" cv
  SET "voteCount" = GREATEST(0, cv."voteCount" + (
    CASE WHEN EXISTS (SELECT 1 FROM inserted) THEN 1 ELSE -1 END
  ))
  WHERE cv."id" = sqlc.arg('versionId')
  RETURNING cv."voteCount"
)
SELECT 
  (EXISTS (SELECT 1 FROM inserted))::boolean AS voted,
  "voteCount"
FROM updated;

-- name: ListChapterVersions :many
SELECT 
  cv."id",
  cv."authorId",
  cv."voteCount",
  cv."isCanonical",
  cv."visibility",
  cv."source",
  cv."createdAt",
  cv."contentId",
  u."name" AS author_name,
  u."image" AS author_image,
  CASE WHEN cvv."userId" IS NOT NULL THEN true ELSE false END AS has_voted,
  CASE WHEN dc."id" IS NOT NULL AND dc."content" IS NOT NULL AND dc."content" != '' THEN true ELSE false END AS is_content_valid,
  COALESCE(dc."content", '') AS content
FROM "ChapterVersion" cv
LEFT JOIN "User" u ON u."id" = cv."authorId"
LEFT JOIN "DocumentContent" dc ON dc."id" = cv."contentId"
LEFT JOIN "ChapterVersionVote" cvv ON cvv."versionId" = cv."id" AND (sqlc.narg('user_id')::text IS NOT NULL AND cvv."userId" = sqlc.narg('user_id'))
WHERE cv."documentId" = $1
  AND (cv."visibility" = 'PUBLIC' OR (sqlc.narg('user_id')::text IS NOT NULL AND cv."authorId" = sqlc.narg('user_id')))
ORDER BY cv."isCanonical" DESC, cv."voteCount" DESC, cv."createdAt" DESC;

-- name: CreateChapterVersion :one
INSERT INTO "ChapterVersion" (
  "id", "documentId", "repositoryId", "authorId", "contentId",
  "source", "visibility", "voteCount", "isCanonical", "createdAt", "updatedAt"
) VALUES (
  gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, 0, false, NOW(), NOW()
) RETURNING "id";

-- name: GetChapterVersionAuthorVisibility :one
SELECT "authorId", "visibility" FROM "ChapterVersion" WHERE "id" = $1;

-- name: PublishChapterVersion :execrows
-- 状态守卫内联（消除 check-then-act 窗口）：只有本人私有版本可发布，
-- 并发删除/转正后 0 行受影响，调用方按未命中处理。
UPDATE "ChapterVersion" SET "visibility" = 'PUBLIC', "updatedAt" = NOW()
WHERE "id" = $1 AND "authorId" = $2 AND "visibility" = 'PRIVATE';

-- name: DeleteChapterVersion :execrows
-- 同上：只有本人私有版本可删除，并发状态迁移后 0 行受影响。
DELETE FROM "ChapterVersion"
WHERE "id" = $1 AND "authorId" = $2 AND "visibility" = 'PRIVATE';

-- name: GetChapterVersionForPin :one
SELECT cv."documentId", cv."repositoryId", d."ownerUserId", u."role"
FROM "ChapterVersion" cv
JOIN "Document" d ON d."id" = cv."documentId"
JOIN "Repository" r ON r."id" = cv."repositoryId"
LEFT JOIN "User" u ON u."id" = $2
WHERE cv."id" = $1;

-- name: GetDocumentForPromotion :one
SELECT d."id", d."path", d."repositoryId", r."owner", r."repo"
FROM "Document" d
JOIN "Repository" r ON r."id" = d."repositoryId"
WHERE d."id" = $1;

-- name: GetCandidatesForPin :many
SELECT "id", "voteCount", "isCanonical", "pinnedAt", "contentId", "authorId", "visibility"
FROM "ChapterVersion"
WHERE "documentId" = $1 AND ("visibility" = 'PUBLIC' OR "id" = $2)
ORDER BY "voteCount" DESC;

-- name: GetCandidatesForVote :many
SELECT "id", "voteCount", "isCanonical", "pinnedAt", "contentId", "authorId", "visibility"
FROM "ChapterVersion"
WHERE "documentId" = $1 AND "visibility" = 'PUBLIC'
ORDER BY "voteCount" DESC;

-- name: GetDocumentContentForPromotion :one
SELECT "content", "generationModel" FROM "DocumentContent" WHERE "id" = $1;

-- name: DemoteOldCanonicals :exec
UPDATE "ChapterVersion"
SET "isCanonical" = false, "pinnedAt" = NULL, "updatedAt" = NOW()
WHERE "documentId" = $1 AND "isCanonical" = true;

-- name: PinNewCanonical :exec
UPDATE "ChapterVersion"
SET "isCanonical" = true, "visibility" = 'PUBLIC', "pinnedAt" = NOW(), "updatedAt" = NOW()
WHERE "id" = $1;

-- name: DemoteIncumbent :execrows
UPDATE "ChapterVersion"
SET "isCanonical" = false, "updatedAt" = NOW()
WHERE "id" = $1 AND "isCanonical" = true;

-- name: PromoteWinner :execrows
UPDATE "ChapterVersion"
SET "isCanonical" = true, "updatedAt" = NOW()
WHERE "id" = $1 AND "isCanonical" = false;

-- name: UpdateDocumentPointer :exec
UPDATE "Document"
SET "contentId" = sqlc.arg('contentId'),
    content = CASE WHEN sqlc.arg('dualWrite')::boolean THEN sqlc.arg('content')::text ELSE NULL END,
    "generationModel" = NULLIF(sqlc.arg('generationModel')::text, ''),
    "generationLevel" = COALESCE(NULLIF(sqlc.arg('generationLevel')::text, ''), "generationLevel"),
    "updatedAt" = NOW()
WHERE "id" = sqlc.arg('id');

-- name: ChapterVersionInsertNotification :exec
INSERT INTO "Notification" ("id", "userId", "type", "title", "body", "payload", "createdAt")
VALUES ($1, $2, $3, $4, $5, $6, NOW());

-- name: DeleteStalePublicVersions :execrows
DELETE FROM "ChapterVersion"
WHERE "visibility" = 'PUBLIC' AND "isCanonical" = false AND "voteCount" = 0
  AND "createdAt" < $1;

-- name: DeleteExpiredPrivateVersions :execrows
DELETE FROM "ChapterVersion"
WHERE "visibility" = 'PRIVATE' AND "createdAt" < $1;
