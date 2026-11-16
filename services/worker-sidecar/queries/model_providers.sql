-- name: ListUserModelProvidersByUserID :many
SELECT "id", "userId", "providerKey", "name", "baseUrl", "apiKey", "apiFormat", "models", "selectedModel", "isActive", "healthStatus", "latencyMs", "lastError", "lastTestedAt", "createdAt", "updatedAt"
FROM "UserModelProvider"
WHERE "userId" = $1
ORDER BY "isActive" DESC, "updatedAt" DESC;

-- name: GetUserModelProviderByID :one
SELECT "id", "userId", "providerKey", "name", "baseUrl", "apiKey", "apiFormat", "models", "selectedModel", "isActive", "healthStatus", "latencyMs", "lastError", "lastTestedAt", "createdAt", "updatedAt"
FROM "UserModelProvider"
WHERE "id" = $1 AND "userId" = $2;

-- name: GetUserModelProviderIDByKey :one
SELECT "id"
FROM "UserModelProvider"
WHERE "userId" = $1 AND "providerKey" = $2;

-- name: CountUserModelProvidersByUserID :one
SELECT COUNT(*)::bigint
FROM "UserModelProvider"
WHERE "userId" = $1;

-- name: DeactivateOtherUserModelProviders :exec
UPDATE "UserModelProvider"
SET "isActive" = false, "updatedAt" = NOW()
WHERE "userId" = $1 AND "isActive" = true AND "id" != $2;

-- name: DeactivateAllUserModelProviders :exec
UPDATE "UserModelProvider"
SET "isActive" = false, "updatedAt" = NOW()
WHERE "userId" = $1 AND "isActive" = true;

-- name: UpdateUserModelProvider :one
UPDATE "UserModelProvider"
SET "name" = sqlc.arg('name'),
    "baseUrl" = sqlc.arg('base_url'),
    "apiKey" = CASE WHEN sqlc.arg('api_key')::text != '' THEN sqlc.arg('api_key')::text ELSE "apiKey" END,
    "apiFormat" = sqlc.arg('api_format'),
    "models" = sqlc.arg('models')::text[],
    "selectedModel" = sqlc.arg('selected_model'),
    "isActive" = CASE WHEN sqlc.arg('is_active')::boolean THEN true ELSE "isActive" END,
    "updatedAt" = NOW()
WHERE "id" = sqlc.arg('id') AND "userId" = sqlc.arg('user_id')
RETURNING "id", "userId", "providerKey", "name", "baseUrl", "apiKey", "apiFormat", "models", "selectedModel", "isActive", "healthStatus", "latencyMs", "lastError", "lastTestedAt", "createdAt", "updatedAt";

-- name: InsertUserModelProvider :one
INSERT INTO "UserModelProvider" (
    "id", "userId", "providerKey", "name", "baseUrl", "apiKey", "apiFormat",
    "models", "selectedModel", "isActive", "healthStatus", "createdAt", "updatedAt"
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'unknown', NOW(), NOW()
)
RETURNING "id", "userId", "providerKey", "name", "baseUrl", "apiKey", "apiFormat", "models", "selectedModel", "isActive", "healthStatus", "latencyMs", "lastError", "lastTestedAt", "createdAt", "updatedAt";

-- name: PatchUserModelProviderActiveAndModel :one
UPDATE "UserModelProvider"
SET "isActive" = true,
    "selectedModel" = CASE WHEN sqlc.arg('selected_model')::text != '' THEN sqlc.arg('selected_model')::text ELSE "selectedModel" END,
    "updatedAt" = NOW()
WHERE "id" = sqlc.arg('id') AND "userId" = sqlc.arg('user_id')
RETURNING "id", "userId", "providerKey", "name", "baseUrl", "apiKey", "apiFormat", "models", "selectedModel", "isActive", "healthStatus", "latencyMs", "lastError", "lastTestedAt", "createdAt", "updatedAt";

-- name: PatchUserModelProviderSelectedModel :one
UPDATE "UserModelProvider"
SET "selectedModel" = $3,
    "updatedAt" = NOW()
WHERE "id" = $1 AND "userId" = $2
RETURNING "id", "userId", "providerKey", "name", "baseUrl", "apiKey", "apiFormat", "models", "selectedModel", "isActive", "healthStatus", "latencyMs", "lastError", "lastTestedAt", "createdAt", "updatedAt";

-- name: GetTargetProviderForDelete :one
SELECT "id", "isActive"
FROM "UserModelProvider"
WHERE "userId" = $1 AND "providerKey" = $2;

-- name: DeleteUserModelProviderByID :exec
DELETE FROM "UserModelProvider"
WHERE "id" = $1 AND "userId" = $2;

-- name: GetRemainingFirstProviderID :one
SELECT "id"
FROM "UserModelProvider"
WHERE "userId" = $1
ORDER BY "updatedAt" DESC
LIMIT 1;

-- name: SetUserModelProviderActiveByID :exec
UPDATE "UserModelProvider"
SET "isActive" = true, "updatedAt" = NOW()
WHERE "id" = $1;

-- name: GetActiveUserModelProvider :one
SELECT "id", "userId", "providerKey", "name", "baseUrl", "apiKey", "apiFormat", "models", "selectedModel", "isActive", "healthStatus", "latencyMs", "lastError", "lastTestedAt", "createdAt", "updatedAt"
FROM "UserModelProvider"
WHERE "userId" = $1 AND "isActive" = true
ORDER BY "updatedAt" DESC
LIMIT 1;

-- name: GetUserModelProviderCipher :one
SELECT "apiKey"
FROM "UserModelProvider"
WHERE "userId" = $1 AND "providerKey" = $2;
