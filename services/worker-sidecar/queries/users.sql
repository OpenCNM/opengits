-- name: CreateOrUpdateAuthUser :one
INSERT INTO "User" ("id", "name", "email", "image", "creditBalance", "signupGiftAt", "createdAt")
VALUES ($1, $2, $3, $4, $5, $6, now())
ON CONFLICT ("email") DO UPDATE SET
    "name" = COALESCE(EXCLUDED."name", "User"."name"),
    "image" = COALESCE(EXCLUDED."image", "User"."image")
RETURNING "id", "name", "email", "image", "createdAt", "creditBalance", "signupGiftAt";

-- name: CreateAuthUserNoEmail :one
INSERT INTO "User" ("id", "name", "email", "image", "creditBalance", "signupGiftAt", "createdAt")
VALUES ($1, $2, $3, $4, $5, $6, now())
RETURNING "id", "name", "email", "image", "createdAt", "creditBalance", "signupGiftAt";

-- name: GetUserMutationFieldsByID :one
SELECT "id", "name", "email", "image", "role", "isBanned", "tier", "mcpRpmLimit", "dailyMcpQuota", "singleCallTokenCap"
FROM "User"
WHERE "id" = $1;

-- name: DeleteUserByID :execrows
DELETE FROM "User"
WHERE "id" = $1;
