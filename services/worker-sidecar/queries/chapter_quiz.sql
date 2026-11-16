-- name: DeleteDocumentQuizzes :exec
DELETE FROM "ChapterQuiz" WHERE "documentId" = $1;

-- name: InsertChapterQuiz :exec
INSERT INTO "ChapterQuiz" (
    id, "documentId", "repositoryId", question, options, "correctIndex", explanation, "order", "createdAt", "updatedAt"
) VALUES (
    gen_random_uuid()::text, $1, $2, $3, $4, $5, NULLIF($6, ''), $7, now(), now()
);

-- name: GetDocumentQuizzesByPath :many
SELECT q.id, q.question, q.options, q."correctIndex", q.explanation, q."order"
FROM "ChapterQuiz" q
JOIN "Document" d ON d.id = q."documentId"
WHERE d."repositoryId" = $1 AND d.path = $2 AND d."ownerUserId" IS NULL AND d.status = 'PROCESSED'
ORDER BY q."order" ASC;
