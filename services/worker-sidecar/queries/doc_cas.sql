-- name: LoadDocumentForPrepare :one
SELECT d.id, d."repositoryId", d.path, COALESCE(d.title, '')::text as title, d.status,
       COALESCE(d.content, dc.content, '')::text as content, d."ownerUserId",
       r.owner, r.repo, r.branch, r."gitSha",
       COALESCE(r."repoProfile"::text, '{}')::text as profile, COALESCE(r."navTree"::text, 'null')::text as nav_tree
FROM "Document" d
JOIN "Repository" r ON r.id = d."repositoryId"
LEFT JOIN "DocumentContent" dc ON dc.id = d."contentId"
WHERE d.id = $1;

-- name: LoadActiveUserModelId :one
SELECT "selectedModel" FROM "UserModelProvider"
WHERE "userId" = $1 AND "isActive" = true
ORDER BY "createdAt" ASC LIMIT 1;

-- name: FindReusableContentByFingerprint :one
SELECT dc.id, COALESCE(dc.content, '')::text as content, (
	SELECT d.id FROM "Document" d
	WHERE d."contentId" = dc.id AND d.status = 'PROCESSED'
	ORDER BY (d."generationLevel" IS NOT NULL) DESC, d."updatedAt" DESC, d.id DESC
	LIMIT 1
) AS donor_doc_id, (
	SELECT d."generationLevel" FROM "Document" d
	WHERE d."contentId" = dc.id AND d.status = 'PROCESSED'
	ORDER BY (d."generationLevel" IS NOT NULL) DESC, d."updatedAt" DESC, d.id DESC
	LIMIT 1
) AS donor_generation_level
FROM "DocumentContent" dc
WHERE dc."requestFingerprint" = $1;

-- name: CountContentChunks :one
SELECT COUNT(*) FROM "DocumentChunk" WHERE "contentId" = $1;

-- name: GetLlmsTxtRepository :one
SELECT "owner", "repo", "branch", "category", "semVerLabel", "navTree"
FROM "Repository"
WHERE id = $1;

-- name: GetLlmsTxtDocuments :many
SELECT d.id, d.title, d.path, d.summary, COALESCE(dc.content, d.content, '')::text AS content, d."ownerUserId"
FROM "Document" d
LEFT JOIN "DocumentContent" dc ON d."contentId" = dc.id
WHERE d."repositoryId" = $1
  AND d.status = 'PROCESSED'
  AND ((sqlc.narg('ownerUserId')::text IS NULL AND d."ownerUserId" IS NULL) OR (sqlc.narg('ownerUserId')::text IS NOT NULL AND (d."ownerUserId" IS NULL OR d."ownerUserId" = sqlc.narg('ownerUserId'))))
ORDER BY d.path ASC;

-- name: FindContentHash :one
SELECT "id", "requestFingerprint"
FROM "DocumentContent"
WHERE "contentHash" = $1;

-- name: SetContentFingerprint :exec
UPDATE "DocumentContent" SET "requestFingerprint" = $1, "updatedAt" = NOW()
WHERE "id" = $2 AND "requestFingerprint" IS NULL;

-- name: InsertContentHash :execrows
INSERT INTO "DocumentContent" ("id", "contentHash", "requestFingerprint", "content", "lang", "generationModel", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, sqlc.arg('contentHash')::text, NULLIF(sqlc.narg('requestFingerprint')::text, '')::text, sqlc.arg('content')::text, sqlc.arg('lang')::text, NULLIF(sqlc.narg('generationModel')::text, '')::text, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- name: InsertContentHashFallback :execrows
INSERT INTO "DocumentContent" ("id", "contentHash", "requestFingerprint", "content", "lang", "generationModel", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, sqlc.arg('contentHash')::text, NULL, sqlc.arg('content')::text, sqlc.arg('lang')::text, NULLIF(sqlc.narg('generationModel')::text, '')::text, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- name: FindOrphanContent :many
SELECT dc."id"
FROM "DocumentContent" dc
LEFT JOIN "Document" d ON d."contentId" = dc."id"
LEFT JOIN "ChapterVersion" cv ON cv."contentId" = dc."id"
WHERE d."id" IS NULL
  AND cv."id" IS NULL
  AND dc."updatedAt" < $1
LIMIT $2;

-- name: DeleteOrphanContent :execrows
DELETE FROM "DocumentContent" WHERE "id" = ANY(@ids::text[]);

-- name: DeleteContentChunks :execrows
DELETE FROM "DocumentChunk" WHERE "contentId" = $1;

-- name: CopyDocumentChunksToContent :execrows
INSERT INTO "DocumentChunk" ("id", "contentId", "heading", "headingPath", "semVerLabel", "contentType", "content", "order", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, $1, dc."heading", dc."headingPath", dc."semVerLabel", dc."contentType", dc."content", dc."order", NOW(), NOW()
FROM "DocumentChunk" dc WHERE dc."documentId" = $2
ORDER BY dc."order" ASC, dc."createdAt" ASC;

-- name: LockDocumentForUpdate :one
SELECT "id" FROM "Document" WHERE "id" = $1 FOR UPDATE;

-- name: UnlinkTutorialConceptNodeChunks :exec
UPDATE "TutorialConceptNode" SET "chunkId" = NULL, "updatedAt" = NOW() WHERE "documentId" = $1;

-- name: DeleteDocumentChunks :execrows
DELETE FROM "DocumentChunk" WHERE "documentId" = $1;

-- name: InsertDocumentChunk :execrows
INSERT INTO "DocumentChunk" (
	"id", "documentId", "contentId", "heading", "headingPath", "contentType", "content", "order", "semVerLabel", "createdAt", "updatedAt"
) VALUES (
	gen_random_uuid()::text, sqlc.narg('arg_documentId')::text, sqlc.narg('arg_contentId')::text, NULLIF(sqlc.arg('arg_heading')::text, '')::text, sqlc.narg('arg_headingPath')::text, sqlc.arg('arg_contentType')::text, sqlc.arg('arg_content')::text, sqlc.arg('arg_order')::int, sqlc.narg('arg_semVerLabel')::text, NOW(), NOW()
);
