-- name: MarkAllNotificationsRead :execrows
UPDATE "Notification"
SET "readAt" = $1
WHERE "userId" = $2 AND "readAt" IS NULL;

-- name: MarkNotificationsReadByIDs :execrows
UPDATE "Notification"
SET "readAt" = sqlc.arg('read_at')
WHERE "userId" = sqlc.arg('user_id') AND "id" = ANY(sqlc.arg('ids')::text[]);

-- name: ListNotificationsByUserID :many
SELECT "id", "userId", "type", "title", "body", COALESCE("payload", '{}'::jsonb) AS "payload", "readAt", "createdAt"
FROM "Notification"
WHERE "userId" = sqlc.arg('user_id')
ORDER BY "createdAt" DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountNotificationsByUserID :one
SELECT 
    COUNT(*)::bigint AS "total",
    COUNT(*) FILTER (WHERE "readAt" IS NULL)::bigint AS "unreadCount"
FROM "Notification"
WHERE "userId" = sqlc.arg('user_id');

-- name: CreateNotification :exec
INSERT INTO "Notification" ("id", "userId", "type", "title", "body", "payload", "createdAt")
VALUES ($1, $2, $3, $4, $5, $6, NOW());

-- name: ClearAllNotificationsByUserID :execrows
DELETE FROM "Notification"
WHERE "userId" = sqlc.arg('user_id');
