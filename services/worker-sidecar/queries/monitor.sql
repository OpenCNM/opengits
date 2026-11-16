-- name: InsertMonitorEvent :exec
INSERT INTO "MonitorEvent" ("id", "sessionId", "kind", "pageUrl", "userId", "repositoryId", "fingerprint", "severity", "payload", "createdAt")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW());
