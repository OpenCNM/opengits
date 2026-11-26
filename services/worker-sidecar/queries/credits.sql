-- name: GetCreditGrantsByUserID :many
SELECT "id", "amount", "source", "repositoryId", "path", "createdAt"
FROM "CreditGrantLedger"
WHERE "userId" = $1
ORDER BY "createdAt" DESC
LIMIT $2;

-- name: UpsertFreeSavedRepo :execrows
INSERT INTO "SavedRepo" ("id", "userId", "repositoryId", "autoFollow", "paidCredits", "createdAt")
VALUES ($1, $2, $3, $4, 0, now())
ON CONFLICT ("userId", "repositoryId") DO NOTHING;

-- name: GetSavedRepoID :one
SELECT "id"
FROM "SavedRepo"
WHERE "userId" = $1 AND "repositoryId" = $2
LIMIT 1;

-- name: LockUserBalance :one
SELECT COALESCE("creditBalance", 0)::INT AS "creditBalance"
FROM "User"
WHERE "id" = $1
FOR UPDATE;

-- name: DeductUserBalance :execrows
UPDATE "User"
SET "creditBalance" = "creditBalance" - $1
WHERE "id" = $2 AND "creditBalance" >= $1;

-- name: CreatePaidSavedRepo :exec
INSERT INTO "SavedRepo" ("id", "userId", "repositoryId", "autoFollow", "paidCredits", "createdAt")
VALUES ($1, $2, $3, $4, $5, now());

-- name: InsertCreditGrantLedger :exec
INSERT INTO "CreditGrantLedger" ("id", "userId", "source", "amount", "repositoryId", "path", "createdAt")
VALUES ($1, $2, $3, $4, $5, $6, now());

-- name: IncrementUserBalance :execrows
UPDATE "User"
SET "creditBalance" = COALESCE("creditBalance", 0) + $1
WHERE "id" = $2;

-- name: CheckImportRewardGranted :one
SELECT 1::int
FROM "CreditGrantLedger"
WHERE "repositoryId" = $1 AND "source" = 'IMPORT_REWARD'
LIMIT 1;

-- name: CheckPendingCreditGrantExists :one
SELECT 1::int
FROM "PendingCreditGrant"
WHERE "repositoryId" = $1
LIMIT 1;

-- name: UpdateRepoTranscriptionCreditsEarned :execrows
UPDATE "Repository"
SET "transcriptionCreditsEarned" = COALESCE("transcriptionCreditsEarned", 0) + $1,
    "updatedAt" = now()
WHERE "id" = $2;

-- name: InsertNotification :exec
INSERT INTO "Notification" ("id", "userId", "type", "title", "body", "payload", "createdAt")
VALUES ($1, $2, $3, $4, $5, $6, now());

-- name: ListChapterUpdateJobsByClaimed :many
SELECT "id", "baseCredits", "actualCredits", "status", "repositoryId", "path", "updatedAt"
FROM "ChapterUpdateJob"
WHERE "claimedBy" = $1 AND "status" = ANY($2::text[])
ORDER BY "updatedAt" DESC
LIMIT $3;

-- name: ListImportJobsByUserId :many
SELECT "id", "params", "result", "createdAt"
FROM "ImportJob"
WHERE "userId" = $1 AND "status" = 'COMPLETED'
ORDER BY "createdAt" DESC
LIMIT $2;

-- name: ListPaidSavedReposByUserId :many
SELECT "id", "repositoryId", "paidCredits", "createdAt"
FROM "SavedRepo"
WHERE "userId" = $1 AND "paidCredits" > 0
ORDER BY "createdAt" DESC
LIMIT $2;

-- name: GetUserBalanceAndSignupGift :one
SELECT "signupGiftAt", COALESCE("creditBalance", 0)::int AS "creditBalance"
FROM "User"
WHERE "id" = $1;

-- name: CountSavedReposByUserId :one
SELECT COUNT(*)::bigint
FROM "SavedRepo"
WHERE "userId" = $1;

-- name: ListRepositoriesByIds :many
SELECT "id", "owner", "repo"
FROM "Repository"
WHERE "id" = ANY($1::text[]);

-- name: LockImportRewardAdvisory :exec
SELECT pg_advisory_xact_lock(hashtext('import-reward:' || $1::text));

-- name: InsertPendingCreditGrant :exec
INSERT INTO "PendingCreditGrant" ("id", "userId", "repositoryId", "amount", "source", "status", "unlockAt", "createdAt", "updatedAt")
VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, now(), now());

-- name: ListDuePendingCreditGrants :many
SELECT "id", "userId", "repositoryId", "amount", "source", "status", "unlockAt"
FROM "PendingCreditGrant"
WHERE "status" = 'PENDING' AND "unlockAt" <= now()
ORDER BY "unlockAt" ASC
LIMIT $1;

-- name: UnlockPendingCreditGrant :execrows
UPDATE "PendingCreditGrant"
SET "status" = 'UNLOCKED', "unlockedAt" = now(), "updatedAt" = now()
WHERE "id" = $1 AND "status" = 'PENDING';

-- name: CancelPendingCreditGrantsByRepo :execrows
UPDATE "PendingCreditGrant"
SET "status" = 'CANCELLED', "cancelledAt" = now(), "updatedAt" = now()
WHERE "repositoryId" = $1 AND "status" = 'PENDING';

-- name: DetachSavedReposByRepo :execrows
UPDATE "SavedRepo"
SET "autoFollow" = false
WHERE "repositoryId" = $1;
