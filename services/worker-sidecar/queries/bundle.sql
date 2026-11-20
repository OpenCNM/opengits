-- name: IncrementBundleUseCount :exec
UPDATE "McpBundle" SET "useCount" = "useCount" + 1 WHERE "id" = $1 OR "slug" = $1;

-- name: InsertMcpBundle :one
INSERT INTO "McpBundle" (
    "id", "title", "slug", "description", "badge",
    "isPinned", "isStarterPack", "starterCategory", "displayOrder", "useCount", "createdAt", "updatedAt"
) VALUES (
    gen_random_uuid()::text, $1, $2, $3, $4,
    $5, $6, $7, $8, 0, NOW(), NOW()
)
RETURNING "id", "title", "slug", "description", "badge", "isPinned", "isStarterPack", "starterCategory", "displayOrder", "useCount", "createdAt", "updatedAt";

-- name: LinkBundleRepository :exec
INSERT INTO "_BundleRepositories" ("A", "B")
VALUES ($1, $2)
ON CONFLICT ("A", "B") DO NOTHING;

-- name: GetBundleRepositories :many
SELECT r."id", r."owner", r."repo", r."category"
FROM "Repository" r
JOIN "_BundleRepositories" br ON br."B" = r."id"
WHERE br."A" = $1
ORDER BY r."id";

-- name: UpdateMcpBundle :one
UPDATE "McpBundle"
SET "title" = COALESCE(NULLIF($2, ''), "title"),
    "description" = COALESCE($3, "description"),
    "badge" = COALESCE($4, "badge"),
    "isPinned" = $5,
    "isStarterPack" = $6,
    "starterCategory" = $7,
    "displayOrder" = $8,
    "updatedAt" = NOW()
WHERE "id" = $1
RETURNING "id", "title", "slug", "description", "badge", "isPinned", "isStarterPack", "starterCategory", "displayOrder", "useCount", "createdAt", "updatedAt";

-- name: ClearBundleRepositories :exec
DELETE FROM "_BundleRepositories" WHERE "A" = $1;

-- name: DeleteMcpBundle :execrows
DELETE FROM "McpBundle" WHERE "id" = $1 OR "slug" = $1;
