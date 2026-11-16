-- name: ClearTutorialConceptChunkRef :exec
UPDATE "TutorialConceptNode" SET "chunkId" = NULL WHERE "documentId" = $1;

-- name: GetDocumentChunksForConcepts :many
SELECT id, heading, "headingPath", content
FROM "DocumentChunk"
WHERE "documentId" = $1
ORDER BY "order" ASC;

-- name: BatchUpsertConcepts :many
INSERT INTO "TutorialConceptNode" (
    id, "repositoryId", "documentId", "chunkId", "headingPath",
    "conceptName", slug, "canonicalKey", "canonicalName",
    category, "principlesText", "authorReflections", "sopSteps",
    summary, "subTopics", tags, "createdAt", "updatedAt"
)
SELECT 
    gen_random_uuid()::text,
    @repository_id::text,
    @document_id::text,
    NULLIF(u.chunk_id, ''),
    u.heading_path,
    u.concept_name,
    u.slug,
    NULLIF(u.canonical_key, ''),
    u.canonical_name,
    u.category,
    NULLIF(u.principles_text, ''),
    NULLIF(u.author_reflections, ''),
    (SELECT COALESCE(array_agg(x), ARRAY[]::text[]) FROM jsonb_array_elements_text(u.sop_steps) AS x),
    NULLIF(u.summary, ''),
    (SELECT COALESCE(array_agg(x), ARRAY[]::text[]) FROM jsonb_array_elements_text(u.sub_topics) AS x),
    (SELECT COALESCE(array_agg(x), ARRAY[]::text[]) FROM jsonb_array_elements_text(u.tags) AS x),
    now(),
    now()
FROM (
    SELECT 
        unnest(@chunk_ids::text[]) AS chunk_id,
        unnest(@heading_paths::text[]) AS heading_path,
        unnest(@concept_names::text[]) AS concept_name,
        unnest(@slugs::text[]) AS slug,
        unnest(@canonical_keys::text[]) AS canonical_key,
        unnest(@canonical_names::text[]) AS canonical_name,
        unnest(@categories::text[]) AS category,
        unnest(@principles_texts::text[]) AS principles_text,
        unnest(@author_reflections::text[]) AS author_reflections,
        unnest(@sop_steps::jsonb[]) AS sop_steps,
        unnest(@summaries::text[]) AS summary,
        unnest(@sub_topics::jsonb[]) AS sub_topics,
        unnest(@tags::jsonb[]) AS tags
) AS u
ON CONFLICT ("repositoryId", slug) DO UPDATE SET
    "conceptName" = EXCLUDED."conceptName",
    "canonicalKey" = EXCLUDED."canonicalKey",
    "canonicalName" = EXCLUDED."canonicalName",
    "category" = EXCLUDED."category",
    "principlesText" = EXCLUDED."principlesText",
    "authorReflections" = EXCLUDED."authorReflections",
    "sopSteps" = EXCLUDED."sopSteps",
    "summary" = EXCLUDED."summary",
    "subTopics" = EXCLUDED."subTopics",
    "tags" = EXCLUDED."tags",
    "documentId" = EXCLUDED."documentId",
    "chunkId" = EXCLUDED."chunkId",
    "headingPath" = EXCLUDED."headingPath",
    "updatedAt" = now()
RETURNING id, slug, "chunkId", "conceptName";

-- name: DeleteObsoleteConcepts :exec
DELETE FROM "TutorialConceptNode"
WHERE "documentId" = $1 AND NOT (slug = ANY(@keep_slugs::text[]));

-- name: GetCanonicalGroupsByKeys :many
SELECT "canonicalKey", "conceptName" FROM "TutorialConceptNode"
WHERE "repositoryId" = $1 AND "canonicalKey" = ANY(@keys::text[]);

-- name: BatchUpdateCanonicalNames :exec
UPDATE "TutorialConceptNode" t
SET "canonicalName" = update_data.rep, "updatedAt" = now()
FROM (
    SELECT unnest(@keys::text[]) AS key, unnest(@reps::text[]) AS rep
) AS update_data
WHERE t."repositoryId" = $1
  AND t."canonicalKey" = update_data.key
  AND t."canonicalName" IS DISTINCT FROM update_data.rep;

-- name: GetDocumentConceptNodes :many
SELECT id, slug, "chunkId", "conceptName" FROM "TutorialConceptNode"
WHERE "documentId" = $1 ORDER BY "createdAt" ASC;

-- name: GetConceptNodesForCooccurrence :many
SELECT id, "chunkId"
FROM "TutorialConceptNode"
WHERE "documentId" = $1;

-- name: DeleteCooccurrenceEdges :exec
DELETE FROM "TutorialConceptEdge"
WHERE source = 'cooccurrence'
  AND ("sourceId" = ANY(@concept_ids::text[]) OR "targetId" = ANY(@concept_ids::text[]));

-- name: BatchInsertConceptEdges :exec
INSERT INTO "TutorialConceptEdge" (
    id, "repositoryId", "sourceId", "targetId", type, weight, source, meta, "createdAt", "updatedAt"
)
SELECT 
    gen_random_uuid()::text,
    @repository_id::text,
    u.source_id,
    u.target_id,
    u.type,
    u.weight,
    u.source,
    u.meta::jsonb,
    now(),
    now()
FROM (
    SELECT 
        unnest(@source_ids::text[]) AS source_id,
        unnest(@target_ids::text[]) AS target_id,
        unnest(@types::text[]) AS type,
        unnest(@weights::float8[]) AS weight,
        unnest(@sources::text[]) AS source,
        unnest(@metas::jsonb[]) AS meta
) AS u
ON CONFLICT ("sourceId", "targetId", type) DO NOTHING;

-- name: BatchInsertLlmConceptEdges :exec
INSERT INTO "TutorialConceptEdge" (
    id, "repositoryId", "sourceId", "targetId", type, weight, source, meta, "createdAt", "updatedAt"
)
SELECT 
    gen_random_uuid()::text,
    @repository_id::text,
    u.source_id,
    u.target_id,
    u.type,
    u.weight,
    u.source,
    u.meta::jsonb,
    now(),
    now()
FROM (
    SELECT 
        unnest(@source_ids::text[]) AS source_id,
        unnest(@target_ids::text[]) AS target_id,
        unnest(@types::text[]) AS type,
        unnest(@weights::float8[]) AS weight,
        unnest(@sources::text[]) AS source,
        unnest(@metas::jsonb[]) AS meta
) AS u;

-- name: GetActiveTutorialOutlinePaths :many
SELECT d.path
FROM "TutorialOutline" o
JOIN "OutlineChapter" c ON c."outlineId" = o.id
JOIN "OutlineNode" n ON n."chapterId" = c.id
JOIN "Document" d ON d.id = n."documentId"
WHERE o."repositoryId" = $1 AND o."isActive" = true
ORDER BY c."teachingOrder", n."teachingOrder";

-- name: GetRepositoryNavTree :one
SELECT "navTree" FROM "Repository" WHERE id = $1;

-- name: GetDocumentPathById :one
SELECT path FROM "Document" WHERE id = $1;

-- name: GetConceptIdsByDocId :many
SELECT id FROM "TutorialConceptNode" WHERE "documentId" = $1;

-- name: GetProcessedDocsByPaths :many
SELECT id, path
FROM "Document"
WHERE "repositoryId" = $1 AND path = ANY(@paths::text[]) AND status = 'PROCESSED';

-- name: GetDocsHavingConcepts :many
SELECT "documentId"
FROM "TutorialConceptNode"
WHERE "repositoryId" = $1 AND "documentId" = ANY(@document_ids::text[])
GROUP BY "documentId";

-- name: DeleteCurriculumOrderEdges :exec
DELETE FROM "TutorialConceptEdge"
WHERE source = 'curriculum_order'
  AND "targetId" = ANY(@target_ids::text[]);

-- name: GetEstablishedConceptEdges :many
SELECT "sourceId", "targetId", type 
FROM "TutorialConceptEdge"
WHERE "repositoryId" = $1 AND type IN ('prerequisite', 'successor');

-- name: DeleteLlmExtractedEdges :exec
DELETE FROM "TutorialConceptEdge"
WHERE "repositoryId" = $1 AND source = 'llm_extracted'
  AND ("sourceId" = ANY(@concept_ids::text[]) OR "targetId" = ANY(@concept_ids::text[]));

-- name: ListRecentCanonicalConcepts :many
-- relay 术语表源（镜像 concept-queries.ts buildRepositoryConceptTaxonomy 的
-- 名字列表语义）：updatedAt 最近的正典概念行，Go 层按 canonicalKey 去重
-- （代表变体优先 conceptName==canonicalName），上限由调用方截断。
SELECT "conceptName", "canonicalKey", "canonicalName"
FROM "TutorialConceptNode"
WHERE "repositoryId" = $1
ORDER BY "updatedAt" DESC
LIMIT $2;
