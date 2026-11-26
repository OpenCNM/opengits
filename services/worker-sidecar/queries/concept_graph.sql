-- name: ClearDocumentConceptChunks :exec
UPDATE "TutorialConceptNode" SET "chunkId" = NULL, "updatedAt" = NOW() WHERE "documentId" = $1;

-- name: UpdateCanonicalConceptNamesAndKeys :execrows
UPDATE "TutorialConceptNode"
SET "canonicalName" = $1,
    "canonicalKey" = COALESCE($2, "canonicalKey"),
    "updatedAt" = NOW()
WHERE "id" = ANY($3::text[]);

-- name: AcquireAdvisoryLockHashtext :exec
SELECT pg_advisory_xact_lock(hashtext($1::text));

-- name: DeleteConceptEdgesByRepository :exec
DELETE FROM "TutorialConceptEdge"
WHERE "repositoryId" = $1 AND "source" = ANY($2::text[]);

-- name: DeleteConceptEdgesByTarget :exec
DELETE FROM "TutorialConceptEdge"
WHERE "source" = ANY($1::text[]) AND "targetId" = ANY($2::text[]);

-- name: DeleteConceptEdgesByBoth :exec
DELETE FROM "TutorialConceptEdge"
WHERE "source" = ANY($1::text[]) AND ("sourceId" = ANY($2::text[]) OR "targetId" = ANY($2::text[]));

-- name: InsertConceptEdge :execrows
INSERT INTO "TutorialConceptEdge" (
    "id", "repositoryId", "sourceId", "targetId", "type", "weight", "source", "meta", "createdAt", "updatedAt"
) VALUES (
    gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW()
)
ON CONFLICT ("sourceId", "targetId", "type") DO NOTHING;
