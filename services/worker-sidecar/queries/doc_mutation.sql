-- name: CheckDocumentExists :one
SELECT EXISTS(
    SELECT 1 FROM "Document"
    WHERE "repositoryId" = $1
      AND "path" = $2
      AND ("ownerUserId" = sqlc.narg('ownerUserId')::text OR (sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL))
)::boolean as "exists";

-- name: InsertDocument :exec
INSERT INTO "Document" (
    "id", "repositoryId", "path", "ownerUserId",
    "title", "content", "status", "createdAt", "updatedAt"
) VALUES (sqlc.arg('id')::text, sqlc.arg('repositoryId')::text, sqlc.arg('path')::text, sqlc.narg('ownerUserId')::text, sqlc.narg('title')::text, sqlc.narg('content')::text, sqlc.arg('status')::text, NOW(), NOW());

-- name: GetDocumentIdByPathAndOwner :one
SELECT "id" FROM "Document"
WHERE "repositoryId" = $1
  AND "path" = $2
  AND ("ownerUserId" = sqlc.narg('ownerUserId')::text OR (sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL))
LIMIT 1;



-- name: AcquireDocumentLock :execrows
UPDATE "Document"
SET "status" = 'PROCESSING', "errorMessage" = NULL, "updatedAt" = NOW()
WHERE "id" = $1 AND "status" != 'PROCESSING';

-- name: HeartbeatDocument :exec
UPDATE "Document"
SET "updatedAt" = NOW()
WHERE "id" = $1 AND "status" = 'PROCESSING';



-- name: RecoverStaleDocumentsByRepo :execrows
UPDATE "Document"
SET "status" = 'UNPROCESSED', "errorMessage" = NULL, "updatedAt" = NOW()
WHERE "status" = 'PROCESSING'
  AND "updatedAt" < $1
  AND "repositoryId" = $2;

-- name: RecoverStaleDocuments :execrows
UPDATE "Document"
SET "status" = 'UNPROCESSED', "errorMessage" = NULL, "updatedAt" = NOW()
WHERE "status" = 'PROCESSING'
  AND "updatedAt" < $1;

-- name: GetDocumentStatus :one
SELECT "status" FROM "Document" WHERE "id" = $1;



-- name: BatchDeleteDocsByIds :execrows
DELETE FROM "Document"
WHERE "repositoryId" = $1
  AND "id" = ANY(@ids::text[])
  AND ("ownerUserId" = sqlc.narg('ownerUserId')::text OR (sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL));

-- name: CheckDocumentExistsByPath :one
SELECT EXISTS(
    SELECT 1 FROM "Document"
    WHERE "repositoryId" = $1
      AND "path" = $2
      AND ("ownerUserId" = sqlc.narg('ownerUserId')::text OR (sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL))
)::boolean as "exists";

-- name: RenameDocument :execrows
UPDATE "Document" SET "path" = $1, "updatedAt" = NOW()
WHERE "repositoryId" = $2
  AND "path" = $3
  AND ("ownerUserId" = sqlc.narg('ownerUserId')::text OR (sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL));

-- name: MarkDocumentsUnprocessed :execrows
UPDATE "Document" SET
    "content" = NULL,
    "status" = 'UNPROCESSED',
    "errorMessage" = NULL,
    "gitSha" = NULL,
    "updatedAt" = NOW()
WHERE "repositoryId" = $1
  AND "path" = ANY(@paths::text[])
  AND ("ownerUserId" = sqlc.narg('ownerUserId')::text OR (sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL));

-- name: BatchDeleteDocsByPathRows :execrows
DELETE FROM "Document"
WHERE "repositoryId" = $1
  AND "path" = ANY(@paths::text[])
  AND ("ownerUserId" = sqlc.narg('ownerUserId')::text OR (sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL));

-- name: GetSharedDocumentPaths :many
SELECT "path" FROM "Document"
WHERE "repositoryId" = $1 AND "ownerUserId" IS NULL;

-- name: DeleteUserDocumentsByPaths :execrows
DELETE FROM "Document"
WHERE "repositoryId" = $1
  AND "ownerUserId" = $2
  AND "path" = ANY(@paths::text[]);

-- name: TransferUserDocumentsToShared :execrows
UPDATE "Document" SET "ownerUserId" = NULL, "updatedAt" = NOW()
WHERE "repositoryId" = $1 AND "ownerUserId" = $2;

-- name: ResetDocumentStatus :one
UPDATE "Document" SET
    "status" = 'UNPROCESSED',
    "content" = NULL,
    "errorMessage" = NULL,
    "updatedAt" = NOW()
WHERE "id" = $1
RETURNING "id", "path", "status";

-- name: ResetDocumentTranscriptionJob :exec
DELETE FROM "TranscriptionJob" WHERE "documentId" = $1;
