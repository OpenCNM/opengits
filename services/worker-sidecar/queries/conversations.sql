-- name: ConvGetRepoByOwnerRepo :one
SELECT "id", "isPublic" FROM "Repository" WHERE "owner" = $1 AND "repo" = $2 LIMIT 1;

-- name: ConvCheckSavedRepo :one
SELECT 1 FROM "SavedRepo" WHERE "repositoryId" = $1 AND "userId" = $2 LIMIT 1;

-- name: ConvListConversations :many
SELECT "id", "title", "createdAt", "updatedAt"
FROM "Conversation"
WHERE "userId" = $1 AND "repositoryId" = $2
ORDER BY "updatedAt" DESC;

-- name: ConvCheckConversationOwner :one
SELECT 1 FROM "Conversation" WHERE "id" = $1 AND "userId" = $2 LIMIT 1;

-- name: ConvGetMessages :many
SELECT "id", "role", "content", "toolInvocations", "createdAt"
FROM "ConversationMessage"
WHERE "conversationId" = $1
ORDER BY "createdAt" ASC;

-- name: ConvGetRepoIsPublic :one
SELECT "isPublic" FROM "Repository" WHERE "id" = $1 LIMIT 1;

-- name: ConvCreateConversation :one
INSERT INTO "Conversation" ("id", "userId", "repositoryId", "title", "createdAt", "updatedAt")
VALUES ($1, $2, $3, $4, NOW(), NOW())
RETURNING "id", "userId", "repositoryId", "title", "createdAt", "updatedAt";

-- name: ConvUpdateConversationTitle :one
UPDATE "Conversation"
SET "title" = $1, "updatedAt" = NOW()
WHERE "id" = $2 AND "userId" = $3
RETURNING "id", "userId", "repositoryId", "title", "createdAt", "updatedAt";

-- name: ConvDeleteConversation :execrows
DELETE FROM "Conversation" WHERE "id" = $1 AND "userId" = $2;
