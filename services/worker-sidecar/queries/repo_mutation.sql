-- name: IncrementRepoTranscriptionTokens :exec
UPDATE "Repository" SET "transcriptionTokens" = COALESCE("transcriptionTokens", 0) + $1, "updatedAt" = now() WHERE "id" = $2;

-- name: IncrementRepoMcpCallCount :exec
UPDATE "Repository" SET "mcpCallCount" = "mcpCallCount" + $1 WHERE "id" = $2;

-- name: BatchIncrementRepoMcpCallCount :exec
UPDATE "Repository" SET "mcpCallCount" = "mcpCallCount" + $1 WHERE "id" = ANY($2::text[]);

-- name: IncrementRepoAutoSwapCount :one
UPDATE "Repository" SET "autoSwapCount" = COALESCE("autoSwapCount", 0) + $1, "updatedAt" = now() WHERE "id" = $2 RETURNING "autoSwapCount";

-- name: DeleteRepoById :execrows
DELETE FROM "Repository" WHERE "id" = $1;

-- name: DeleteRepoByTuple :execrows
DELETE FROM "Repository" WHERE "owner" = $1 AND "repo" = $2 AND "branch" = $3 AND "edition" = $4;

-- name: SetRepoUnpublish :execrows
UPDATE "Repository"
SET "isPublic" = false,
    "unpublishCooldownUntil" = NULL,
    "unpublishRequestedAt" = now(),
    "updatedAt" = now()
WHERE "id" = $1;

-- name: GetRepoUnpublishState :one
SELECT "id", "owner", "repo", "isPublic", "unpublishCooldownUntil", "unpublishRequestedAt"
FROM "Repository"
WHERE "id" = $1;

-- name: GetRepoForPromotion :one
SELECT "id", "owner", "repo", "branch", "edition", "isPublic"
FROM "Repository"
WHERE "id" = $1
FOR UPDATE;

-- name: GetDefaultRepoForPromotion :one
SELECT "id", "owner", "repo", "branch", "edition", "isPublic"
FROM "Repository"
WHERE "owner" = $1 AND "repo" = $2 AND "branch" = $3 AND "edition" = '' AND "id" != $4
LIMIT 1
FOR UPDATE;

-- name: MigrateSavedReposForPromotion :execrows
UPDATE "SavedRepo" AS sr
SET "repositoryId" = $1
WHERE sr."repositoryId" = $2
  AND NOT EXISTS (
    SELECT 1 FROM "SavedRepo" AS existing
    WHERE existing."repositoryId" = $1 AND existing."userId" = sr."userId"
  );

-- name: MigrateHelpfulVotesForPromotion :execrows
UPDATE "HelpfulVote" AS hv
SET "repositoryId" = $1
WHERE hv."repositoryId" = $2
  AND NOT EXISTS (
    SELECT 1 FROM "HelpfulVote" AS existing
    WHERE existing."repositoryId" = $1 AND existing."userId" = hv."userId"
  );

-- name: MigrateImportRecordsForPromotion :execrows
UPDATE "ImportRecord" AS ir
SET "repositoryId" = $1
WHERE ir."repositoryId" = $2
  AND NOT EXISTS (
    SELECT 1 FROM "ImportRecord" AS existing
    WHERE existing."repositoryId" = $1 AND existing."userId" = ir."userId" AND existing."branch" = ir."branch"
  );

-- name: MigrateReadingProgressForPromotion :execrows
UPDATE "UserReadingProgress" AS urp
SET "repositoryId" = $1
WHERE urp."repositoryId" = $2
  AND NOT EXISTS (
    SELECT 1 FROM "UserReadingProgress" AS existing
    WHERE existing."repositoryId" = $1 AND existing."userId" = urp."userId"
  );

-- name: PromoteRepoToDefault :execrows
UPDATE "Repository"
SET "edition" = '',
    "isPublic" = true,
    "reviewStatus" = 'APPROVED',
    "publishedAt" = COALESCE("publishedAt", now()),
    "helpfulCount" = (SELECT COUNT(*)::int FROM "HelpfulVote" WHERE "repositoryId" = $1),
    "unpublishCooldownUntil" = NULL,
    "unpublishRequestedAt" = NULL,
    "updatedAt" = now()
WHERE "id" = $1;

-- name: DeleteDuplicatePrivateDocsForPromotion :execrows
DELETE FROM "Document" d1
WHERE d1."repositoryId" = $1
  AND d1."ownerUserId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "Document" d2
    WHERE d2."repositoryId" = $1
      AND d2."ownerUserId" IS NULL
      AND d2."path" = d1."path"
  );

-- name: TransferRepoDocsToSharedForPromotion :execrows
UPDATE "Document"
SET "ownerUserId" = NULL,
    "updatedAt" = now()
WHERE "repositoryId" = $1
  AND "ownerUserId" IS NOT NULL;



