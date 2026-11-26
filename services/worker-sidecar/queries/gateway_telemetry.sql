-- name: TouchMcpPresence :exec
INSERT INTO "McpActiveSession" (id, "userId", "clientName", "clientVer", "ipAddress", "lastSeenAt", status)
VALUES (gen_random_uuid()::text, $1, $2, NULLIF($3, ''), NULLIF($4, ''), now(), 'ACTIVE')
ON CONFLICT ("userId", "clientName") DO UPDATE
SET "lastSeenAt" = now(), status = 'ACTIVE',
    "clientVer" = COALESCE(NULLIF($3, ''), "McpActiveSession"."clientVer"),
    "ipAddress" = COALESCE(NULLIF($4, ''), "McpActiveSession"."ipAddress");

-- name: IncrementMcpUsage :exec
INSERT INTO "McpUsageLedger" (id, "userId", day, "mcpCalls", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1, $2, 1, now(), now())
ON CONFLICT ("userId", day) DO UPDATE
SET "mcpCalls" = "McpUsageLedger"."mcpCalls" + 1, "updatedAt" = now();

-- name: RecordMcpCallLog :exec
INSERT INTO "McpCallLog" (
    id, "toolName", "userId", "clientName", "repositoryId", "bundleId",
    dimension, status, "resultCount", "responseTimeMs",
    "requestedEdition", "resolvedEdition", "isFallback", "createdAt"
) VALUES (
    gen_random_uuid()::text, $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
    $6, $7, $8, $9,
    NULLIF($10, ''), NULLIF($11, ''), $12, now()
);

-- name: RecordGithubQuotaSample :exec
INSERT INTO "GithubQuotaLog" (
    id, fingerprint, remaining, "resetAt", "endpointClass", status, "createdAt"
) VALUES (
    gen_random_uuid()::text, $1, $2, $3, $4, $5, now()
);
