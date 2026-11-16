-- name: MCPFindConceptForDocWithHeading :one
SELECT n.id, n."conceptName", n."canonicalKey", n.category, d.path, n."documentId"
FROM "TutorialConceptNode" n LEFT JOIN "Document" d ON d.id = n."documentId"
WHERE n."repositoryId" = $1 AND n."documentId" = $2
  AND (n."headingPath" = $3 OR n."headingPath" LIKE '%' || $3 || '%')
ORDER BY n."updatedAt" DESC LIMIT 1;

-- name: MCPFindConceptForDocNoHeading :one
SELECT n.id, n."conceptName", n."canonicalKey", n.category, d.path, n."documentId"
FROM "TutorialConceptNode" n LEFT JOIN "Document" d ON d.id = n."documentId"
WHERE n."repositoryId" = $1 AND n."documentId" = $2
ORDER BY n."updatedAt" DESC LIMIT 1;

-- name: MCPConceptGramCandidates :many
SELECT n.id, n."conceptName", n.category, n.slug, n."headingPath", n."principlesText",
       n."authorReflections", n.summary, n."sopSteps", n."subTopics", n.tags, n."canonicalKey", d.path, n."canonicalName"
FROM "TutorialConceptNode" n LEFT JOIN "Document" d ON d.id = n."documentId"
WHERE n."repositoryId" = $1 AND (n."conceptName" ILIKE ANY($2::text[]))
ORDER BY n."updatedAt" DESC LIMIT 40;

-- name: MCPResolveConceptNodeStage1Key :one
SELECT n.id, n."conceptName", n.category, n.slug, n."headingPath", n."principlesText",
       n."authorReflections", n.summary, n."sopSteps", n."subTopics", n.tags, n."canonicalKey", d.path, n."canonicalName"
FROM "TutorialConceptNode" n LEFT JOIN "Document" d ON d.id = n."documentId"
WHERE n."repositoryId" = $1 AND (
	LOWER(n.slug) = LOWER($2) OR LOWER(n."conceptName") = LOWER($2) OR LOWER(n."canonicalName") = LOWER($2)
    OR n."canonicalKey" = $3
) ORDER BY n."updatedAt" DESC LIMIT 1;

-- name: MCPResolveConceptNodeStage1NoKey :one
SELECT n.id, n."conceptName", n.category, n.slug, n."headingPath", n."principlesText",
       n."authorReflections", n.summary, n."sopSteps", n."subTopics", n.tags, n."canonicalKey", d.path, n."canonicalName"
FROM "TutorialConceptNode" n LEFT JOIN "Document" d ON d.id = n."documentId"
WHERE n."repositoryId" = $1 AND (
	LOWER(n.slug) = LOWER($2) OR LOWER(n."conceptName") = LOWER($2) OR LOWER(n."canonicalName") = LOWER($2)
) ORDER BY n."updatedAt" DESC LIMIT 1;

-- name: MCPResolveConceptNodeStage2 :one
SELECT n.id, n."conceptName", n.category, n.slug, n."headingPath", n."principlesText",
       n."authorReflections", n.summary, n."sopSteps", n."subTopics", n.tags, n."canonicalKey", d.path, n."canonicalName"
FROM "TutorialConceptNode" n LEFT JOIN "Document" d ON d.id = n."documentId"
WHERE n."repositoryId" = $1 AND LOWER(n."conceptName") LIKE LOWER($2)
ORDER BY n."updatedAt" DESC LIMIT 1;

-- name: MCPLearningPathEdges :many
SELECT "sourceId", "targetId", type, weight, source FROM "TutorialConceptEdge"
WHERE "repositoryId" = $1 AND type IN ('prerequisite', 'successor');

-- name: MCPConceptEditionCompare :many
SELECT r."edition" AS repo_edition,
       n."conceptName",
       n."principlesText",
       n."summary"
FROM "TutorialConceptNode" n
JOIN "Repository" r ON r."id" = n."repositoryId"
WHERE lower(r."owner") = lower(@owner::text)
  AND lower(r."repo") = lower(@repo::text)
  AND r."isPublic" = true
  AND (n."slug" = lower(@concept::text) OR lower(n."conceptName") = lower(@concept::text))
ORDER BY r."edition" ASC
LIMIT 20;
