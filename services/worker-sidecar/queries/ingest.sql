-- name: UpdateRepositorySyncStatus :exec
UPDATE "Repository"
SET "hasUpstreamUpdate" = false,
    "upstreamCheckedAt" = now(),
    "upstreamEtag" = NULLIF(@upstream_etag::text, ''),
    "updatedAt" = now()
WHERE id = @id;

-- name: UpdateRepositorySyncStatusWithProfile :exec
UPDATE "Repository"
SET "hasUpstreamUpdate" = false,
    "upstreamCheckedAt" = now(),
    "upstreamEtag" = NULLIF(@upstream_etag::text, ''),
    "repoProfile" = COALESCE("repoProfile", '{}'::jsonb) || @profile_patch::jsonb,
    "updatedAt" = now()
WHERE id = @id;

-- name: UpsertRepositoryRow :one
INSERT INTO "Repository"
  (id, owner, repo, branch, edition, skeleton, "skeletonHash", "navTree", "repoProfile",
   "isPublic", category, tags, "gitSha", "bestUsedFor", "starCount", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NULLIF($5,''), NULLIF($6,''), NULL, $7::jsonb,
   $8, $9, $10, $11, $12, GREATEST($13,0), now(), now())
ON CONFLICT (owner, repo, branch, edition) DO UPDATE SET
  branch = EXCLUDED.branch,
  "repoProfile" = EXCLUDED."repoProfile",
  "isPublic" = EXCLUDED."isPublic",
  category = EXCLUDED.category,
  tags = EXCLUDED.tags,
  skeleton = COALESCE(NULLIF($5,''), "Repository".skeleton),
  "skeletonHash" = COALESCE(NULLIF($6,''), "Repository"."skeletonHash"),
  "gitSha" = COALESCE(EXCLUDED."gitSha", "Repository"."gitSha"),
  "bestUsedFor" = COALESCE(EXCLUDED."bestUsedFor", "Repository"."bestUsedFor"),
  "starCount" = CASE WHEN EXCLUDED."starCount" > 0 THEN EXCLUDED."starCount" ELSE "Repository"."starCount" END,
  "updatedAt" = now()
RETURNING id;

-- name: UpsertContentLayer :one
INSERT INTO "DocumentContent" (id, "contentHash", content, lang, "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, $2, $3, now(), now())
ON CONFLICT ("contentHash") DO UPDATE SET
	content = COALESCE("DocumentContent".content, EXCLUDED.content),
	"updatedAt" = now()
RETURNING id;

-- name: UpdateOwnedDocumentWithContent :exec
UPDATE "Document" SET title = $1, content = $2, "contentId" = $3, status = $4, "updatedAt" = now()
WHERE id = $5;

-- name: UpdateOwnedDocumentTitle :exec
UPDATE "Document" SET title = $1, "updatedAt" = now()
WHERE id = $2;

-- name: InsertOwnedDocument :one
INSERT INTO "Document" (id, "repositoryId", path, "ownerUserId", title, content, "contentId", status, "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, now(), now())
RETURNING id;

-- name: ResetDocumentsUnprocessedPaths :execrows
UPDATE "Document" SET content = NULL, "contentId" = NULL, status = 'UNPROCESSED',
    "errorMessage" = NULL, "gitSha" = NULL, "updatedAt" = now()
WHERE "repositoryId" = $1
  AND ((sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL) OR (sqlc.narg('ownerUserId')::text IS NOT NULL AND "ownerUserId" = sqlc.narg('ownerUserId')::text))
  AND path = ANY(@paths::text[]);

-- name: DeleteRepositoryRow :execrows
DELETE FROM "Repository"
WHERE owner = $1 AND repo = $2 AND branch = $3 AND edition = $4;

-- name: GetImportRecordSha :one
SELECT sha FROM "ImportRecord"
WHERE "userId" = $1 AND "repositoryId" = $2 AND branch = $3;

-- name: DeleteDocumentsByPaths :exec
DELETE FROM "Document"
WHERE "repositoryId" = $1
  AND ((sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL) OR (sqlc.narg('ownerUserId')::text IS NOT NULL AND "ownerUserId" = sqlc.narg('ownerUserId')::text))
  AND path = ANY(@paths::text[]);

-- name: UpsertImportRecord :exec
INSERT INTO "ImportRecord" (id, "userId", "repositoryId", owner, repo, branch, sha, "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, now(), now())
ON CONFLICT ("userId", "repositoryId", branch) DO UPDATE SET
  sha = EXCLUDED.sha, "updatedAt" = now();

-- name: GetMaxTutorialOutlineVersion :one
SELECT COALESCE(MAX(version), 0)::int AS max_version FROM "TutorialOutline" WHERE "repositoryId" = $1;

-- name: InsertTutorialOutline :one
INSERT INTO "TutorialOutline" (id, "repositoryId", mode, version, "isActive", "createdAt")
VALUES (gen_random_uuid()::text, $1, 'tutorial', $2, $3, now())
RETURNING id;

-- name: DeactivateOtherOutlines :exec
UPDATE "TutorialOutline"
SET "isActive" = false
WHERE "repositoryId" = $1 AND id != $2 AND "isActive" = true;

-- name: InsertOutlinePart :one
INSERT INTO "OutlinePart" (id, "outlineId", title, summary, "teachingOrder")
VALUES (gen_random_uuid()::text, $1, $2, $3, $4)
RETURNING id;

-- name: GetDocumentIdsAndOwner :many
SELECT id, path, "ownerUserId"
FROM "Document"
WHERE "repositoryId" = $1
ORDER BY "ownerUserId" ASC NULLS FIRST;

-- name: InsertOutlineChapter :one
INSERT INTO "OutlineChapter" (id, "outlineId", "partId", title, summary, "chapterType", "teachingOrder")
VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)
RETURNING id;

-- name: InsertOutlineNode :exec
INSERT INTO "OutlineNode" (id, "chapterId", "documentId", title, "nodeType", "headingPath", "teachingOrder")
VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NULL, $5);

-- name: ActivateOutline :execrows
UPDATE "TutorialOutline"
SET "isActive" = true
WHERE "id" = $1;

-- name: DeactivateAllOutlines :exec
UPDATE "TutorialOutline"
SET "isActive" = false
WHERE "repositoryId" = $1 AND "isActive" = true;

-- name: GetRepositoryForWebSync :one
SELECT id, "isPublic", branch, "upstreamEtag", "repoProfile"
FROM "Repository"
WHERE owner = $1 AND repo = $2
LIMIT 1;

-- name: GetDocumentExistingOwner :one
SELECT "ownerUserId"
FROM "Document"
WHERE "repositoryId" = $1
ORDER BY "createdAt" ASC
LIMIT 1;

-- name: PeekRepositoryForCommit :one
SELECT id, "gitSha" FROM "Repository"
WHERE owner=$1 AND repo=$2 AND branch=$3 AND edition=$4 LIMIT 1;

-- name: RestoreRepositoryGitSha :execrows
-- CAS 回滚：仅当 gitSha 仍等于本次导入写入的 expect_sha 时才回退 restore_sha，
-- 防止并发邻居任务已提交更新的 sha 被旧回滚覆写；0 行 = CAS miss（调用方留痕）。
-- narg：restore_sha 可空（原仓库无 sha 时回退 NULL），expect_sha 同型对齐。
-- 不触碰 updatedAt：回滚是「恢复原状」而非状态演进，避免审计面把失败补偿
-- 误读为一次真实更新。
UPDATE "Repository" SET "gitSha"=sqlc.narg('restore_sha')::text
WHERE id=sqlc.arg('id')::text AND "gitSha" IS NOT DISTINCT FROM sqlc.narg('expect_sha')::text;
