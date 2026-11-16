package search

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// GetFtsLanguageConfig 恒返回 simple：DocumentChunk.searchVector 生成列固定
// to_tsvector('simple', ...)（prisma/schema.prisma），查询侧 english 词干化会在
// simple 索引上产生变形漂移（如 better→good 前缀不命中）造成静默漏检。
// 查询配置必须与索引列配置锁步，语义对齐优先于词干化收益。
func GetFtsLanguageConfig(locale string) string {
	_ = locale
	return "simple"
}

func getFtsLanguageConfig(locale string) string {
	return GetFtsLanguageConfig(locale)
}

var (
	tsQueryNonWordRe = regexp.MustCompile(`[^\w` + mdpat.CJKScriptClass + `\s]`)
	tsQueryWordRe    = regexp.MustCompile(`[\w` + mdpat.CJKScriptClass + `]`)
	tsQueryTokenRe   = regexp.MustCompile(`[\w.-]+|[` + mdpat.CJKScriptClass + `]+`)
)

func BuildTsQuery(query string) string {
	if strings.TrimSpace(query) == "" {
		return ""
	}
	cleaned := tsQueryNonWordRe.ReplaceAllString(query, " ")
	fields := strings.Fields(cleaned)
	var terms []string
	for _, f := range fields {
		if len(f) >= 1 && tsQueryWordRe.MatchString(f) && strings.Trim(f, "_") != "" {
			terms = append(terms, f+":*")
		}
	}
	if len(terms) == 0 {
		return ""
	}
	return strings.Join(terms, " & ")
}

func buildTsQuery(query string) string {
	return BuildTsQuery(query)
}

func ExtractSearchTokens(q string) []string {
	all := tsQueryTokenRe.FindAllString(q, -1)
	var out []string
	for _, t := range all {
		if len([]rune(t)) >= 2 {
			out = append(out, t)
		}
	}
	return out
}

func extractSearchTokens(q string) []string {
	return ExtractSearchTokens(q)
}

const baseEditionLabel = "标准教程"

var transcriptionPresetNames = map[string]string{
	"standard":   "教学解读",
	"deep":       "深度剖析",
	"cheatsheet": "速查手册",
	"faithful":   "忠实原文",
	"analogy":    "类比桥接",
}

// deriveEditionLabel 从 repoProfile 推导教程版本显示名（对齐 TS deriveEditionLabel）。
// 优先级：用户自定义个性化标题 > 驱动/转录模型名称 > 非标转录预设名（如深度剖析版、速查手册版）> 标准教程。
// 核心守约：转录模型为首，绝不将默认预设（standard）作为特征版本名渲染为“教学解读版”。
func deriveEditionLabel(rawProfile []byte) string {
	if len(rawProfile) == 0 {
		return baseEditionLabel
	}
	var profile map[string]any
	if err := json.Unmarshal(rawProfile, &profile); err != nil || profile == nil {
		return baseEditionLabel
	}
	if label, ok := profile["editionLabel"].(string); ok && strings.TrimSpace(label) != "" {
		trimmed := strings.TrimSpace(label)
		if trimmed != "标准教程" && trimmed != "默认" && trimmed != "教学解读版" && trimmed != "教学解读" && !strings.HasPrefix(trimmed, "讲法 ") {
			return trimmed
		}
	}
	if model, ok := profile["transcriptionModel"].(string); ok && strings.TrimSpace(model) != "" {
		return strings.TrimSpace(model)
	}
	if model, ok := profile["model"].(string); ok && strings.TrimSpace(model) != "" {
		return strings.TrimSpace(model)
	}
	var presetID string
	if ep, ok := profile["editionPreset"].(string); ok && strings.TrimSpace(ep) != "" {
		presetID = strings.TrimSpace(ep)
	} else if tp, ok := profile["transcriptionPreset"].(string); ok && strings.TrimSpace(tp) != "" {
		presetID = strings.TrimSpace(tp)
	}
	if presetID != "" {
		name, exists := transcriptionPresetNames[presetID]
		if !exists {
			presetID = "standard"
			name = transcriptionPresetNames["standard"]
		}
		if presetID != "standard" {
			return name + "版"
		}
	}
	return baseEditionLabel
}

// BuildVersionFilterPredicate 版本过滤谓词（纯函数，供表驱动测试锁定语义）：
// 精确 = 与前缀 ILIKE 'v%' 两档，chunk semVerLabel / Repository semVerLabel / branch 同口径；
// 双 NULL（chunk 与 repo 均未标注版本）放行。禁止裸子串（"v5" 不得命中 "v15.0.0"）。
func BuildVersionFilterPredicate(exactIdx, prefixIdx int) string {
	return fmt.Sprintf(
		`("DocumentChunk"."semVerLabel" = $%d OR "Repository"."semVerLabel" = $%d OR "Repository"."branch" = $%d OR "DocumentChunk"."semVerLabel" ILIKE $%d OR "Repository"."semVerLabel" ILIKE $%d OR "Repository"."branch" ILIKE $%d OR ("DocumentChunk"."semVerLabel" IS NULL AND "Repository"."semVerLabel" IS NULL AND "Repository"."id" = $1))`,
		exactIdx, exactIdx, exactIdx, prefixIdx, prefixIdx, prefixIdx,
	)
}

func buildRepoSearchFromJoin(userArgIdx int) string {
	d2OwnerPred := `d2."ownerUserId" IS NULL`
	if userArgIdx > 0 {
		d2OwnerPred = fmt.Sprintf(`(d2."ownerUserId" IS NULL OR d2."ownerUserId" = $%d)`, userArgIdx)
	}
	return fmt.Sprintf(`
FROM "DocumentChunk"
JOIN "Document" ON "Document"."id" = COALESCE(
  "DocumentChunk"."documentId",
  (
    SELECT d2."id" FROM "Document" d2
    WHERE d2."contentId" = "DocumentChunk"."contentId"
      AND d2."status" = 'PROCESSED'
      AND d2."repositoryId" = $1
      AND %s
    ORDER BY (d2."ownerUserId" IS NULL) DESC, d2."id" ASC
    LIMIT 1
  )
)
JOIN "Repository" ON "Document"."repositoryId" = "Repository"."id"`, d2OwnerPred)
}

func buildGlobalSearchFromJoin(userArgIdx int) string {
	d2OwnerPred := `d2."ownerUserId" IS NULL`
	if userArgIdx > 0 {
		d2OwnerPred = fmt.Sprintf(`(d2."ownerUserId" IS NULL OR d2."ownerUserId" = $%d)`, userArgIdx)
	}
	return fmt.Sprintf(`
FROM "DocumentChunk"
JOIN "Document" ON "Document"."id" = COALESCE(
  "DocumentChunk"."documentId",
  (
    SELECT d2."id" FROM "Document" d2
    WHERE d2."contentId" = "DocumentChunk"."contentId"
      AND d2."status" = 'PROCESSED'
      AND %s
    ORDER BY (d2."ownerUserId" IS NULL) DESC, d2."id" ASC
    LIMIT 1
  )
)
JOIN "Repository" ON "Document"."repositoryId" = "Repository"."id"`, d2OwnerPred)
}

func buildStage0ConceptSQL(searchFromJoin string, baseFilters []string, conceptIdx, slugIdx, limitIdx int) string {
	return fmt.Sprintf(`
			SELECT "DocumentChunk"."id" AS chunk_id,
			       "Document"."id" AS doc_id,
			       "DocumentChunk"."heading",
			       "DocumentChunk"."headingPath",
			       "DocumentChunk"."content",
			       "Document"."title",
			       "Document"."path",
			       COALESCE("Repository"."edition", '') AS repo_edition,
			       COALESCE("Repository"."repoProfile"::text, '{}') AS repo_profile,
			       1.0::float8 AS fts_rank
			%s
			JOIN "TutorialConceptNode" ON "TutorialConceptNode"."chunkId" = "DocumentChunk"."id"
			  AND "TutorialConceptNode"."repositoryId" = "Repository"."id"
			WHERE %s
			  AND ("TutorialConceptNode"."conceptName" ILIKE $%d OR "TutorialConceptNode"."slug" = $%d)
			ORDER BY "DocumentChunk"."id" ASC
			LIMIT $%d`,
		searchFromJoin,
		strings.Join(baseFilters, " AND "),
		conceptIdx,
		slugIdx,
		limitIdx,
	)
}

func buildGlobalStage0ConceptSQL(searchFromJoin string, baseFilters []string, conceptIdx, slugIdx, limitIdx int) string {
	return fmt.Sprintf(`
			SELECT "DocumentChunk"."id" AS chunk_id,
			       "Document"."id" AS doc_id,
			       "DocumentChunk"."heading",
			       "DocumentChunk"."headingPath",
			       "DocumentChunk"."content",
			       "Document"."title",
			       "Document"."path",
			       "Repository"."owner" AS repo_owner,
			       "Repository"."repo" AS repo_name,
			       COALESCE("Repository"."edition", '') AS repo_edition,
			       COALESCE("Repository"."repoProfile"::text, '{}') AS repo_profile,
			       1.0::float8 AS fts_rank
			%s
			JOIN "TutorialConceptNode" ON "TutorialConceptNode"."chunkId" = "DocumentChunk"."id"
			  AND "TutorialConceptNode"."repositoryId" = "Repository"."id"
			WHERE %s
			  AND ("TutorialConceptNode"."conceptName" ILIKE $%d OR "TutorialConceptNode"."slug" = $%d)
			ORDER BY "DocumentChunk"."id" ASC
			LIMIT $%d`,
		searchFromJoin,
		strings.Join(baseFilters, " AND "),
		conceptIdx,
		slugIdx,
		limitIdx,
	)
}

func buildConceptSearchSQL(repoID string, userID *string, terms []string) (string, []any) {
	args := []any{repoID}
	userPred := `d."ownerUserId" IS NULL`
	if userID != nil && strings.TrimSpace(*userID) != "" {
		args = append(args, strings.TrimSpace(*userID))
		userPred = fmt.Sprintf(`(d."ownerUserId" IS NULL OR d."ownerUserId" = $%d)`, len(args))
	}

	var orClauses []string
	for _, term := range terms {
		trimmed := strings.TrimSpace(term)
		if trimmed == "" {
			continue
		}
		pattern := "%" + trimmed + "%"
		args = append(args, pattern)
		idx := len(args)
		orClauses = append(orClauses, fmt.Sprintf(`(c."conceptName" ILIKE $%d OR c."canonicalName" ILIKE $%d OR c."summary" ILIKE $%d)`, idx, idx, idx))
	}

	orSQL := "true"
	if len(orClauses) > 0 {
		orSQL = "(" + strings.Join(orClauses, " OR ") + ")"
	}

	sql := fmt.Sprintf(`
		SELECT c."id", c."conceptName", c."category", c."summary", c."principlesText", c."headingPath", d."path", d."title"
		FROM "TutorialConceptNode" c
		JOIN "Document" d ON d."id" = c."documentId"
		WHERE c."repositoryId" = $1
		  AND d."status" = 'PROCESSED'
		  AND %s
		  AND %s
		LIMIT 5`, userPred, orSQL)

	return sql, args
}
