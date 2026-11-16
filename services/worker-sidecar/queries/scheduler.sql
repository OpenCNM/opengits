-- name: DeleteExpiredSessions :execrows
DELETE FROM "Session" WHERE expires < now();

-- name: DeleteQuotaLogsBefore :execrows
DELETE FROM "GithubQuotaLog" WHERE "createdAt" < $1;

-- name: PickOrphanContentIds :many
SELECT dc.id FROM "DocumentContent" dc
WHERE NOT EXISTS (SELECT 1 FROM "Document" d WHERE d."contentId" = dc.id)
  AND NOT EXISTS (SELECT 1 FROM "ChapterVersion" cv WHERE cv."contentId" = dc.id)
  AND NOT EXISTS (SELECT 1 FROM "ChapterUpdateJob" j WHERE j."stagedContentId" = dc.id)
  AND dc."updatedAt" < $1
ORDER BY dc.id
LIMIT $2;

-- name: ActiveRepoKeys :many
SELECT owner, repo FROM "Repository";

-- name: ActiveArchiveKeys :many
SELECT DISTINCT lower(owner) || '/' || lower(repo) || '@' || "gitSha" FROM "Repository" WHERE "gitSha" IS NOT NULL
UNION
SELECT DISTINCT lower(owner) || '/' || lower(repo) || '@' || sha FROM "ImportRecord";

-- name: ReposForUpstreamCheck :many
SELECT id, owner, repo, branch, "gitSha", "hasUpstreamUpdate", "upstreamEtag", "repoProfile"
FROM "Repository"
ORDER BY "upstreamCheckedAt" ASC NULLS FIRST
LIMIT $1;

-- name: TouchUpstreamCheckedWithEtag :exec
UPDATE "Repository" SET "upstreamCheckedAt" = now(), "upstreamEtag" = $1, "updatedAt" = now()
WHERE owner = $2 AND repo = $3 AND branch = $4;

-- name: TouchUpstreamChecked :exec
UPDATE "Repository" SET "upstreamCheckedAt" = now(), "updatedAt" = now()
WHERE owner = $1 AND repo = $2 AND branch = $3;

-- name: WriteUpstreamChangedWithEtag :exec
UPDATE "Repository"
SET "hasUpstreamUpdate" = $1, "upstreamCheckedAt" = now(), "upstreamEtag" = $2, "updatedAt" = now()
WHERE owner = $3 AND repo = $4 AND branch = $5;

-- name: WriteUpstreamChanged :exec
UPDATE "Repository"
SET "hasUpstreamUpdate" = $1, "upstreamCheckedAt" = now(), "updatedAt" = now()
WHERE owner = $2 AND repo = $3 AND branch = $4;

-- name: WriteUpstreamWebCheckedWithPatch :exec
UPDATE "Repository"
SET "hasUpstreamUpdate" = $1,
    "upstreamCheckedAt" = now(),
    "upstreamEtag" = $2,
    "repoProfile" = COALESCE("repoProfile", '{}'::jsonb) || $3::jsonb,
    "updatedAt" = now()
WHERE id = $4;

-- name: WriteUpstreamWebChecked :exec
UPDATE "Repository"
SET "hasUpstreamUpdate" = $1,
    "upstreamCheckedAt" = now(),
    "upstreamEtag" = $2,
    "updatedAt" = now()
WHERE id = $3;

-- name: GetGatewayEmergencyReadOnly :one
SELECT "emergencyReadOnly" FROM "GatewayPolicyConfig" WHERE id = 'singleton';

-- name: InsertSchedulerLease :exec
INSERT INTO "SchedulerLease" ("key", "ownerId", "lockedUntil", "updatedAt")
VALUES ($1, $2, $3, now());

-- name: DeleteSchedulerLease :exec
DELETE FROM "SchedulerLease" WHERE "key" = $1 AND "ownerId" = $2;

-- name: CleanExpiredSchedulerLeases :execrows
DELETE FROM "SchedulerLease" WHERE "lockedUntil" < $1;

-- name: UpdateSchedulerLeaseIfHeldOrExpired :execrows
UPDATE "SchedulerLease"
SET "ownerId" = $1, "lockedUntil" = $2, "updatedAt" = now()
WHERE "key" = $3 AND ("ownerId" = $1 OR "lockedUntil" < now());
