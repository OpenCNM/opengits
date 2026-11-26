-- name: SearchRepoMetaForIndex :one
SELECT id, owner, repo, "gitSha" FROM "Repository" WHERE id = $1;

-- name: SearchOGISChunkRowsForRepo :many
SELECT DISTINCT ch."id", ch."heading", ch."headingPath", ch."content",
       d."title", d."path", ch."order"
FROM "DocumentChunk" ch
JOIN "Document" d ON (
  (ch."documentId" IS NOT NULL AND d."id" = ch."documentId")
  OR (ch."contentId" IS NOT NULL AND d."contentId" = ch."contentId")
)
WHERE d."repositoryId" = $1
  AND d."status" = 'PROCESSED'
ORDER BY d."path" ASC, ch."order" ASC NULLS LAST, ch."id" ASC;

-- name: SearchReposWithProcessedDocs :many
SELECT r.id, r.owner, r.repo, r."gitSha"
FROM "Repository" r
WHERE EXISTS (
  SELECT 1 FROM "Document" d
  WHERE d."repositoryId" = r.id AND d."status" = 'PROCESSED'
);

-- name: GetExactRepositoryForSearch :one
SELECT "id", "owner", "repo", "category", "bestUsedFor"
FROM "Repository"
WHERE LOWER("owner") = LOWER($1) AND LOWER("repo") = LOWER($2) AND "branch" = 'main' AND "isPublic" = true
LIMIT 1;

-- name: GetRepoForInRepoSearch :one
SELECT "id", "owner", "repo"
FROM "Repository"
WHERE LOWER("owner") = LOWER($1) AND LOWER("repo") = LOWER($2) AND "branch" = 'main'
LIMIT 1;

-- name: SearchPublicRepositoriesByFuzzy :many
SELECT "id", "owner", "repo", "category", "bestUsedFor"
FROM "Repository"
WHERE "isPublic" = true
  AND (
    "owner" ILIKE $1 OR
    "repo" ILIKE $1 OR
    "category" ILIKE $2
  )
LIMIT 10;

-- name: SearchPublicBundlesByFuzzy :many
SELECT b."id", b."title", b."slug", COALESCE(b."description", '')::text AS "description", r."owner", r."repo"
FROM "McpBundle" b
JOIN LATERAL (
    SELECT r2."owner", r2."repo"
    FROM "_BundleRepositories" br
    JOIN "Repository" r2 ON r2."id" = br."B"
    WHERE br."A" = b."id" AND r2."isPublic" = true
    ORDER BY r2."id" ASC
    LIMIT 1
) r ON true
WHERE (b."title" ILIKE $1 OR b."description" ILIKE $1)
LIMIT 10;
