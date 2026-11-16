-- name: MCPLookupBookshelfRepo :one
-- owner/repo 精确等值（Go 侧 ResolveBookshelfRepo 已 ToLower 归一，存储行全小写）：
-- 消除 ILIKE 下划线/百分号通配逃逸，且可吃 (owner, repo) 索引。
SELECT r.id, r.owner, r.repo, r.branch, r.edition, r."semVerLabel", r."mcpStatus", r.category, r."isPublic", r."navTree", r."repoProfile"
FROM "SavedRepo" sr
JOIN "Repository" r ON sr."repositoryId" = r.id
JOIN "User" u ON sr."userId" = u.id
WHERE sr."userId" = sqlc.arg('userId')::text
  AND r."mcpStatus" != 'PAUSED'
  AND NOT (r.id = ANY(COALESCE(u."disabledMcpRepoIds", '{}')))
  AND (
    r.id = sqlc.arg('id')::text
    OR (r.owner = sqlc.arg('owner')::text AND r.repo = sqlc.arg('repo')::text)
  )
  AND (sqlc.arg('edition')::text = '' OR r.edition = sqlc.arg('edition')::text)
ORDER BY r.edition ASC, r."updatedAt" DESC
LIMIT 1;

-- name: MCPFindConceptAcrossBookshelf :many
SELECT n.id as concept_id, n."conceptName", n.category, n."globalConceptId", n."headingPath",
       d.path as doc_path, r.id as repo_id, r.owner as repo_owner, r.repo as repo_name
FROM "TutorialConceptNode" n
JOIN "Repository" r ON n."repositoryId" = r.id
JOIN "SavedRepo" sr ON sr."repositoryId" = r.id
JOIN "User" u ON sr."userId" = u.id
LEFT JOIN "Document" d ON n."documentId" = d.id
WHERE sr."userId" = sqlc.arg('userId')::text
  AND r."mcpStatus" != 'PAUSED'
  AND NOT (r.id = ANY(COALESCE(u."disabledMcpRepoIds", '{}')))
  AND (r."isPublic" = true OR d."ownerUserId" IS NULL OR d."ownerUserId" = sqlc.arg('userId')::text)
  AND (
    n."conceptName" ILIKE '%' || sqlc.arg('query')::text || '%'
    OR n."principlesText" ILIKE '%' || sqlc.arg('query')::text || '%'
    OR n.summary ILIKE '%' || sqlc.arg('query')::text || '%'
  )
ORDER BY r.owner ASC, r.repo ASC, n."conceptName" ASC
LIMIT sqlc.arg('limit')::int;

-- name: MCPGlobalConceptsByIDs :many
SELECT id, "canonicalName", aliases FROM "GlobalConcept" WHERE id = ANY($1::text[]);
