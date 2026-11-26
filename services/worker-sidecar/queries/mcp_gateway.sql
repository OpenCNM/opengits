-- name: MCPFindDefaultBranchRepo :one
SELECT id, owner, repo, branch, edition, "semVerLabel", "mcpStatus", category, "isPublic", "navTree", "repoProfile"
FROM "Repository"
WHERE owner = $1 AND repo = $2 AND branch = $3
LIMIT 1;

-- name: MCPHasSavedRepoAccess :one
SELECT 1 FROM "SavedRepo" WHERE "repositoryId" = $1 AND "userId" = $2 LIMIT 1;

-- name: MCPListRepoDocuments :many
SELECT id, path, title, summary
FROM "Document"
WHERE "repositoryId" = $1 AND status = 'PROCESSED'
  AND ("ownerUserId" IS NULL OR "ownerUserId" = $2);

-- name: MCPFindDocContent :one
SELECT d.content AS legacy_content, dc.content AS layered_content
FROM "Document" d
LEFT JOIN "DocumentContent" dc ON dc.id = d."contentId"
WHERE d.id = $1 AND d."repositoryId" = $2 AND d.status = 'PROCESSED'
  AND (d."ownerUserId" IS NULL OR d."ownerUserId" = $3);

-- name: MCPFindBundleDoc :one
SELECT d.title, d.path, d.content AS legacy_content, dc.content AS layered_content
FROM "Document" d
LEFT JOIN "DocumentContent" dc ON dc.id = d."contentId"
WHERE d."repositoryId" = $1
  AND d.status = 'PROCESSED'
  AND d."ownerUserId" IS NULL
  AND (
    LOWER(d.path) = LOWER($2)
    OR LOWER(d.path) = LOWER($2 || '.md')
    OR LOWER(d.path) = LOWER($2 || '.mdx')
  )
LIMIT 1;

-- name: MCPListChunksByDoc :many
SELECT heading, "headingPath", content, "semVerLabel"
FROM "DocumentChunk"
WHERE "documentId" = $1
ORDER BY id ASC;

-- name: MCPListChunkHeadings :many
SELECT heading, "headingPath", "contentType"
FROM "DocumentChunk"
WHERE "documentId" = $1
ORDER BY id ASC
LIMIT $2;

-- name: MCPGetRepoGitSha :one
SELECT owner, repo, "gitSha" FROM "Repository" WHERE id = $1;

-- name: MCPHasPrivateDocs :one
SELECT 1 FROM "Document" WHERE "repositoryId" = $1 AND "ownerUserId" = $2 LIMIT 1;

-- name: MCPCanonicalMemberIDsKey :one
SELECT "canonicalKey" FROM "TutorialConceptNode" WHERE id = $1 AND "repositoryId" = $2;

-- name: MCPGetCanonicalMembers :many
SELECT id FROM "TutorialConceptNode" WHERE "repositoryId" = $1 AND "canonicalKey" = $2;

-- name: MCPEdgesTouching :many
SELECT "sourceId", "targetId", type, weight, source
FROM "TutorialConceptEdge"
WHERE "repositoryId" = $1 AND ("sourceId" = ANY($2::text[]) OR "targetId" = ANY($2::text[]));

-- name: MCPNodesByIDs :many
SELECT n.id, n."conceptName", n."canonicalKey", n."canonicalName", n.category, d.path
FROM "TutorialConceptNode" n
LEFT JOIN "Document" d ON d.id = n."documentId"
WHERE n."repositoryId" = $1 AND n.id = ANY($2::text[]);

-- name: MCPCoLocatedNodes :many
SELECT n.id, n."conceptName", n."canonicalKey", n."canonicalName", n.category, d.path
FROM "TutorialConceptNode" n
LEFT JOIN "Document" d ON d.id = n."documentId"
WHERE n."repositoryId" = $1 AND n."documentId" = $2 AND n.id <> ALL($3::text[])
ORDER BY n."updatedAt" DESC
LIMIT $4;

-- name: MCPGetConceptDocumentID :one
SELECT "documentId" FROM "TutorialConceptNode" WHERE id = $1 AND "repositoryId" = $2;

-- name: MCPListDocConcepts :many
SELECT n.id, n."conceptName", n."canonicalKey", n.category, d.path, n."headingPath"
FROM "TutorialConceptNode" n
LEFT JOIN "Document" d ON d.id = n."documentId"
WHERE n."repositoryId" = $1 AND n."documentId" = $2
ORDER BY n."updatedAt" DESC
LIMIT $3;

-- name: MCPTaxonomyNodes :many
SELECT n.id, n."conceptName", n."canonicalKey", n."canonicalName", n.category, n."headingPath", d.path
FROM "TutorialConceptNode" n
LEFT JOIN "Document" d ON d.id = n."documentId"
WHERE n."repositoryId" = $1
ORDER BY n."updatedAt" DESC
LIMIT $2;

-- name: MCPPrereqEdges :many
SELECT "sourceId", "targetId", type, weight, source
FROM "TutorialConceptEdge"
WHERE "repositoryId" = $1 AND type IN ('prerequisite', 'successor');

-- name: MCPConceptDependencyEdges :many
SELECT e."sourceId", e."targetId", e.type, e.weight, e.source
FROM "TutorialConceptEdge" e
WHERE e."repositoryId" = $1 AND e."targetId" = ANY($2::text[])
  AND e.type IN ('prerequisite', 'successor')
ORDER BY e.weight DESC;

-- name: MCPCountCanonicalMembers :one
SELECT COUNT(*) FROM "TutorialConceptNode" WHERE "repositoryId" = $1 AND "canonicalKey" = $2;

-- name: MCPListUserBookshelfRepos :many
SELECT r.id, r.owner, r.repo, r.branch, r.edition, r."semVerLabel", r."mcpStatus", r.category, r."isPublic",
       r."navTree", r."repoProfile", r.tags, r."isVerified", r."starCount", r."bestUsedFor", r."updatedAt",
       COALESCE(urp."updatedAt", '1970-01-01'::timestamp) as last_read_at
FROM "SavedRepo" sr
JOIN "Repository" r ON sr."repositoryId" = r.id
JOIN "User" u ON sr."userId" = u.id
LEFT JOIN "UserReadingProgress" urp ON urp."userId" = sr."userId" AND urp."repositoryId" = r.id
WHERE sr."userId" = $1
  AND r."mcpStatus" != 'PAUSED'
  AND NOT (r.id = ANY(COALESCE(u."disabledMcpRepoIds", '{}')))
ORDER BY r.edition ASC, r."updatedAt" DESC;

-- name: MCPLookupToken :one
SELECT id, "userId" FROM "McpApiToken" WHERE "tokenHash" = $1 AND "revokedAt" IS NULL LIMIT 1;

-- name: MCPGetUserQuota :one
SELECT role, tier, "isBanned", "mcpRpmLimit", "dailyMcpQuota", "singleCallTokenCap" FROM "User" WHERE id = $1;

-- name: MCPLedgerCount :one
SELECT "mcpCalls" FROM "McpUsageLedger" WHERE "userId" = $1 AND day = $2;

-- name: MCPLedgerIncrement :exec
INSERT INTO "McpUsageLedger" (id, "userId", day, "mcpCalls", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, $2, 1, now(), now())
ON CONFLICT ("userId", day) DO UPDATE
SET "mcpCalls" = "McpUsageLedger"."mcpCalls" + 1, "updatedAt" = now();

-- name: MCPLedgerIncrementBy :exec
INSERT INTO "McpUsageLedger" (id, "userId", day, "mcpCalls", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, $2, $3, now(), now())
ON CONFLICT ("userId", day) DO UPDATE
SET "mcpCalls" = "McpUsageLedger"."mcpCalls" + EXCLUDED."mcpCalls", "updatedAt" = now();

-- name: MCPTouchTokenLastUsed :exec
UPDATE "McpApiToken" SET "lastUsedAt" = now() WHERE id = $1;

-- name: MCPUpsertPresence :exec
INSERT INTO "McpActiveSession" (id, "userId", "clientName", "clientVer", "ipAddress", "lastSeenAt", status)
VALUES (gen_random_uuid()::text, sqlc.arg('userId')::text, sqlc.arg('clientName')::text, NULLIF(sqlc.arg('clientVer')::text, ''), NULLIF(sqlc.arg('ipAddress')::text, ''), now(), 'ACTIVE')
ON CONFLICT ("userId", "clientName") DO UPDATE
SET "lastSeenAt" = now(), status = 'ACTIVE',
    "clientVer" = COALESCE(NULLIF(sqlc.arg('clientVer')::text, ''), "McpActiveSession"."clientVer"),
    "ipAddress" = COALESCE(NULLIF(sqlc.arg('ipAddress')::text, ''), "McpActiveSession"."ipAddress");

-- name: MCPLookupBundle :many
SELECT
	b.id AS b_id, b.slug AS b_slug, b.title AS b_title, b.description AS b_desc,
	r.id AS r_id, r.owner AS r_owner, r.repo AS r_repo, r.category AS r_cat, r."starCount" AS r_stars, r."isVerified" AS r_verified
FROM "McpBundle" b
LEFT JOIN "_BundleRepositories" br ON br."A" = b.id
LEFT JOIN "Repository" r ON r.id = br."B" AND r."mcpStatus" != 'PAUSED' AND r."isPublic" = true
WHERE b.id = $1 OR b.slug = $1;

-- name: MCPIncrementBundleUseCount :exec
UPDATE "McpBundle" SET "useCount" = "useCount" + 1 WHERE id = $1 OR slug = $1;

-- name: MCPListToolPolicies :many
SELECT "toolName", "isEnabled", "tokenBudget", "tierRequirement"
FROM "GlobalMcpToolPolicy";

-- name: MCPInsertCallLog :exec
INSERT INTO "McpCallLog" (id, "toolName", "userId", "clientName", "repositoryId", dimension, status, "resultCount", "responseTimeMs", "createdAt")
VALUES (
    gen_random_uuid()::text,
    sqlc.arg('toolName')::text,
    NULLIF(sqlc.arg('userId')::text, ''),
    NULLIF(sqlc.arg('clientName')::text, ''),
    NULLIF(sqlc.arg('repositoryId')::text, ''),
    NULLIF(sqlc.arg('dimension')::text, ''),
    sqlc.arg('status')::text,
    sqlc.arg('resultCount')::int,
    sqlc.arg('responseTimeMs')::int,
    now()
);

-- name: MCPResolveRepoPersonal :one
SELECT id, owner, repo, branch, edition, "semVerLabel", "mcpStatus", category, "isPublic", "navTree", "repoProfile"
FROM "Repository"
WHERE repo = $1 AND edition = $2
ORDER BY edition ASC, "updatedAt" DESC
LIMIT 1;

-- name: MCPResolveRepoBranchEdition :one
SELECT id, owner, repo, branch, edition, "semVerLabel", "mcpStatus", category, "isPublic", "navTree", "repoProfile"
FROM "Repository"
WHERE owner = $1 AND repo = $2 AND branch = $3 AND edition = $4
ORDER BY edition ASC, "updatedAt" DESC
LIMIT 1;

-- name: MCPResolveRepoEdition :one
SELECT id, owner, repo, branch, edition, "semVerLabel", "mcpStatus", category, "isPublic", "navTree", "repoProfile"
FROM "Repository"
WHERE owner = $1 AND repo = $2 AND edition = $3
ORDER BY edition ASC, "updatedAt" DESC
LIMIT 1;

-- name: MCPInsertCallLogs :exec
INSERT INTO "McpCallLog" (id, "toolName", "userId", "clientName", "repositoryId", dimension, status, "resultCount", "responseTimeMs", "createdAt")
SELECT gen_random_uuid()::text,
       e->>'toolName',
       NULLIF(e->>'userId', ''),
       NULLIF(e->>'clientName', ''),
       NULLIF(e->>'repositoryId', ''),
       NULLIF(e->>'dimension', ''),
       e->>'status',
       (e->>'resultCount')::int,
       (e->>'responseTimeMs')::int,
       now()
FROM jsonb_array_elements(sqlc.arg('entries')::jsonb) AS e;

-- name: MCPIncrementRepoCallsBatch :exec
UPDATE "Repository" r SET "mcpCallCount" = r."mcpCallCount" + (inc->>'n')::int
FROM jsonb_array_elements(sqlc.arg('increments')::jsonb) AS inc
WHERE r.id = inc->>'id';
