-- name: SSEGetUserIdByMcpToken :one
SELECT "userId" FROM "McpApiToken" WHERE "tokenHash" = $1 AND "revokedAt" IS NULL;

-- name: SSEGetImportJobSnapshot :one
SELECT id, "userId", status, error, "createdAt"
FROM "ImportJob"
WHERE id = $1;

-- name: SSEGetImportJobEvents :many
SELECT seq, type, payload
FROM "ImportJobEvent"
WHERE "jobId" = $1 AND seq > $2
ORDER BY seq ASC
LIMIT 500;

-- name: SSEGetQueuedJobPosition :one
SELECT COUNT(*)
FROM "ImportJob"
WHERE status = 'QUEUED' AND "createdAt" < $1;

-- name: SSEListQueuedJobCreatedAts :many
-- 队位 rank map 源查询：hub 每秒一次取回全部 QUEUED 的 createdAt，
-- 进程内算各 job 的排队位（替代每个排队 job 的 poller 每秒一次全表 COUNT）。
SELECT "createdAt"
FROM "ImportJob"
WHERE status = 'QUEUED'
ORDER BY "createdAt" ASC;

-- name: SSEHasTerminalEvent :one
SELECT EXISTS(
	SELECT 1 FROM "ImportJobEvent"
	WHERE "jobId" = $1 AND type IN ('done', 'error')
);

-- name: SSEGetNotificationSnapshot :one
SELECT 
	(SELECT COUNT(*) FROM "Notification" WHERE "Notification"."userId" = $1 AND "Notification"."readAt" IS NULL) AS unread_count,
	(SELECT id FROM "Notification" WHERE "Notification"."userId" = $1 ORDER BY "Notification"."createdAt" DESC LIMIT 1) AS latest_id;

-- name: SSEGetRepositoryForEvents :one
-- 对齐 TS resolveRepository：大小写不敏感匹配 owner/repo，优先命中目标 edition 与 branch，
-- 非默认分支（如 master）与已删/缺失 edition 自动回退基础行，避免 /events 404。
SELECT id, "isPublic"
FROM "Repository"
WHERE LOWER(owner) = LOWER(sqlc.arg('owner')::text)
  AND LOWER(repo) = LOWER(sqlc.arg('repo')::text)
  AND (
    edition = sqlc.arg('edition')::text
    OR edition = ''
    OR sqlc.arg('edition')::text = ''
  )
ORDER BY
  CASE WHEN edition = sqlc.arg('edition')::text THEN 0 WHEN edition = '' THEN 1 ELSE 2 END ASC,
  CASE WHEN branch = sqlc.arg('branch')::text THEN 0 ELSE 1 END ASC,
  edition ASC,
  "updatedAt" DESC
LIMIT 1;

-- name: SSEVerifyRepoAccess :one
SELECT EXISTS(
	SELECT 1 FROM "Repository" r
	LEFT JOIN "User" u ON u.id = $2
	WHERE r.id = $1 AND (
		r.owner = u.name OR 
		EXISTS (SELECT 1 FROM "SavedRepo" s WHERE s."repositoryId" = $1 AND s."userId" = $2)
	)
);

-- name: SSEGetRepoIngestSnapshot :many
SELECT d.id, j.status, j."checkpointChunks", j."checkpointTotal"
FROM "TranscriptionJob" j
JOIN "Document" d ON j."documentId" = d.id
WHERE d."repositoryId" = $1
ORDER BY d.id ASC;

-- name: SSEGetActiveClients :many
SELECT id, "clientName", "clientVer", "lastSeenAt"
FROM "McpActiveSession"
WHERE "userId" = $1 AND "lastSeenAt" >= $2
ORDER BY "lastSeenAt" DESC;

-- name: SSEGetMcpCallDayStats :many
SELECT "clientName", 
       COUNT(*) as total, 
       COUNT(*) FILTER (WHERE status = 'SUCCESS' AND "resultCount" > 0) as hits
FROM "McpCallLog"
WHERE "userId" = $1 AND "createdAt" >= $2
GROUP BY "clientName";

-- name: SSEGetMcpCallRecentTicks :many
SELECT "clientName", status, "resultCount"
FROM "McpCallLog"
WHERE "userId" = $1 AND "createdAt" >= $2
ORDER BY "createdAt" DESC
LIMIT 200;
