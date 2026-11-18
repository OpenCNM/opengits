-- name: GetRepoSemanticGraph :one
SELECT "id", "owner", "repo", "gitSha", "payload", "symbolCount", "updatedAt"
FROM "RepoSemanticGraph"
WHERE "owner" = $1 AND "repo" = $2 AND "gitSha" = $3
LIMIT 1;

-- name: UpsertRepoSemanticGraph :exec
INSERT INTO "RepoSemanticGraph" ("id", "owner", "repo", "gitSha", "payload", "symbolCount", "createdAt", "updatedAt")
VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
ON CONFLICT ("owner", "repo", "gitSha")
DO UPDATE SET
  "payload" = EXCLUDED."payload",
  "symbolCount" = EXCLUDED."symbolCount",
  "updatedAt" = NOW();
