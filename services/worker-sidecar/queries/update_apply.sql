-- name: GetRepoProfile :one
SELECT "repoProfile"
FROM "Repository"
WHERE id = $1;

-- name: GetDocuments :many
SELECT path, title, summary
FROM "Document"
WHERE "repositoryId" = $1
  AND ((sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL) OR (sqlc.narg('ownerUserId')::text IS NOT NULL AND "ownerUserId" = sqlc.narg('ownerUserId')::text))
ORDER BY path ASC;

-- name: ListUpdatableRepos :many
SELECT id, owner, repo, branch, "gitSha", "pendingSyncSha",
       COALESCE("repoProfile"::text, '{}')::text AS repo_profile
FROM "Repository"
WHERE "isPublic" = true AND "autoSyncEnabled" = true
  AND "hasUpstreamUpdate" = true AND "qualityHold" = false
  AND "gitSha" IS NOT NULL
ORDER BY "upstreamCheckedAt" ASC NULLS FIRST
LIMIT $1;

-- name: ListProcessedSharedDocs :many
SELECT id, path FROM "Document"
WHERE "repositoryId" = $1 AND "ownerUserId" IS NULL
  AND status = 'PROCESSED' AND path = ANY(sqlc.arg('paths')::text[]);

-- name: BusyUpdateJobDocIDs :many
SELECT "documentId" FROM "ChapterUpdateJob"
WHERE "repositoryId" = $1 AND status IN ('PENDING','CLAIMED','TRIAL');

-- name: CountActiveUpdateJobs :one
SELECT COUNT(*) FROM "ChapterUpdateJob"
WHERE "repositoryId" = $1 AND status IN ('PENDING','CLAIMED','TRIAL');

-- name: CreateChapterUpdateJob :exec
INSERT INTO "ChapterUpdateJob" (id, "repositoryId", "documentId", path, "fromSha", "toSha", status, "frozenCredits", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'PENDING', 0, now(), now());

-- name: SetPendingSyncSha :exec
UPDATE "Repository" SET "pendingSyncSha" = $1, "updatedAt" = now() WHERE id = $2;

-- name: AdvanceSyncBaseline :exec
UPDATE "Repository"
SET "gitSha" = $1, "pendingSyncSha" = NULL, "hasUpstreamUpdate" = false, "updatedAt" = now()
WHERE id = $2;

-- name: ClearUpstreamUpdate :exec
UPDATE "Repository" SET "hasUpstreamUpdate" = false, "pendingSyncSha" = NULL, "updatedAt" = now()
WHERE id = $1;

-- name: LeaseUpdateIfHeldOrExpired :execrows
UPDATE "SchedulerLease"
SET "ownerId" = $1, "lockedUntil" = $2, "updatedAt" = now()
WHERE "key" = $3 AND ("ownerId" = $1 OR "lockedUntil" < now());

-- name: LeaseInsert :exec
INSERT INTO "SchedulerLease" ("key", "ownerId", "lockedUntil", "updatedAt")
VALUES ($1, $2, $3, now());

-- name: LeaseDelete :exec
DELETE FROM "SchedulerLease" WHERE "key" = $1 AND "ownerId" = $2;

-- name: CleanExpiredLeases :execrows
DELETE FROM "SchedulerLease" WHERE "lockedUntil" < $1;

-- name: CreateUpdateRun :one
INSERT INTO "ImportUpdateRun" ("id", "repositoryId", "userId", "fromSha", "toSha", "status", "plan", "candidateSet", "stats", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, sqlc.narg('plan')::jsonb, sqlc.narg('candidateSet')::jsonb, sqlc.narg('stats')::jsonb, now(), now())
RETURNING "id";

-- name: ClaimUpdateRun :execrows
UPDATE "ImportUpdateRun"
SET "status" = 'APPLYING', "updatedAt" = now()
WHERE "id" = $1 AND "status" IN ('PLANNED', 'FAILED');

-- name: UpdateRunStatus :exec
UPDATE "ImportUpdateRun"
SET "status" = $1,
    "finishedAt" = COALESCE(sqlc.narg('finishedAt'), "finishedAt"),
    "stats" = COALESCE(sqlc.narg('stats')::jsonb, "stats"),
    "updatedAt" = now()
WHERE "id" = $2;

-- name: ApplyTxGetRepository :one
SELECT owner, repo, branch, COALESCE("gitSha", '')::text AS "gitSha", "navTree", "repoProfile"
FROM "Repository"
WHERE id = $1;

-- name: ApplyTxCheckRenameOccupied :one
SELECT id FROM "Document"
WHERE "repositoryId" = $1
  AND ((sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL) OR (sqlc.narg('ownerUserId')::text IS NOT NULL AND "ownerUserId" = sqlc.narg('ownerUserId')::text))
  AND path = $2
LIMIT 1;

-- name: ApplyTxExecuteRename :execrows
UPDATE "Document"
SET path = $1, "updatedAt" = now()
WHERE "repositoryId" = $2
  AND ((sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL) OR (sqlc.narg('ownerUserId')::text IS NOT NULL AND "ownerUserId" = sqlc.narg('ownerUserId')::text))
  AND path = $3;

-- name: ApplyTxBatchUpdateDocs :execrows
UPDATE "Document"
SET content = NULL, "contentId" = NULL, status = 'UNPROCESSED', "errorMessage" = NULL, "gitSha" = NULL, "updatedAt" = now()
WHERE "repositoryId" = $1
  AND ((sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL) OR (sqlc.narg('ownerUserId')::text IS NOT NULL AND "ownerUserId" = sqlc.narg('ownerUserId')::text))
  AND path = ANY(sqlc.arg('paths')::text[]);

-- name: ApplyTxBatchDeleteDocs :execrows
DELETE FROM "Document"
WHERE "repositoryId" = $1
  AND ((sqlc.narg('ownerUserId')::text IS NULL AND "ownerUserId" IS NULL) OR (sqlc.narg('ownerUserId')::text IS NOT NULL AND "ownerUserId" = sqlc.narg('ownerUserId')::text))
  AND path = ANY(sqlc.arg('paths')::text[]);

-- name: ApplyTxBatchInsertDocs :execrows
INSERT INTO "Document" (id, "repositoryId", "ownerUserId", path, title, content, status, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, $1, sqlc.narg('ownerUserId')::text, t.path, t.title, '', 'UNPROCESSED', now(), now()
FROM (SELECT unnest(sqlc.arg(paths)::text[]) AS path, unnest(sqlc.arg(titles)::text[]) AS title) t;

-- name: ApplyTxUpdateRepoProfile :exec
UPDATE "Repository"
SET "gitSha" = $1, "hasUpstreamUpdate" = false, "repoProfile" = $2, "updatedAt" = now()
WHERE id = $3;

-- name: ApplyTxUpdateRepoGitShaOnly :exec
UPDATE "Repository"
SET "gitSha" = $1, "hasUpstreamUpdate" = false, "updatedAt" = now()
WHERE id = $2;

-- name: ApplyTxUpsertImportRecord :exec
INSERT INTO "ImportRecord" (id, "userId", "repositoryId", owner, repo, branch, sha, "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, now(), now())
ON CONFLICT ("userId", "repositoryId", branch) DO UPDATE SET
  sha = EXCLUDED.sha, "updatedAt" = now();

-- name: ApplyTxUpdateImportRunStats :execrows
UPDATE "ImportUpdateRun"
SET status = 'APPLIED', stats = $1, "finishedAt" = now(), "updatedAt" = now()
WHERE id = $2;
