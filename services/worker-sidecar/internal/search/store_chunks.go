package search

import (
	"context"
	"fmt"
	"math"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/ogis"
)

func (s *PgxStore) SearchRepositoryChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("pgx pool is nil")
	}
	if req.RepositoryID == "" || (strings.TrimSpace(req.Query) == "" && strings.TrimSpace(req.RawQuery) == "") {
		return []SearchChunkHit{}, nil
	}

	fallbackQuery := strings.TrimSpace(req.RawQuery)
	if fallbackQuery == "" {
		fallbackQuery = strings.TrimSpace(req.Query)
	}
	searchQuery := strings.TrimSpace(req.Query)
	if searchQuery == "" {
		searchQuery = fallbackQuery
	}

	safeLimit := req.Limit
	if safeLimit <= 0 {
		safeLimit = 30
	} else if safeLimit > 100 {
		safeLimit = 100
	}

	snippetLen := req.SnippetMaxLen
	if snippetLen <= 0 {
		snippetLen = 100
	}

	ftsLanguage := getFtsLanguageConfig(req.Locale)
	tsQueryStr := buildTsQuery(searchQuery)

	baseArgs := []any{req.RepositoryID}
	baseFilters := []string{
		`"Document"."repositoryId" = $1`,
		`"Document"."status" = 'PROCESSED'`,
	}
	argIdx := 2
	userArgIdx := 0

	if req.UserID != nil && *req.UserID != "" {
		userArgIdx = argIdx
		baseFilters = append(baseFilters, fmt.Sprintf(`("Document"."ownerUserId" IS NULL OR "Document"."ownerUserId" = $%d)`, argIdx))
		baseArgs = append(baseArgs, *req.UserID)
		argIdx++
	} else {
		baseFilters = append(baseFilters, `"Document"."ownerUserId" IS NULL`, `"Repository"."isPublic" = true`)
	}

	searchFromJoin := buildRepoSearchFromJoin(userArgIdx)

	if len(req.ContentTypes) > 0 {
		baseFilters = append(baseFilters, fmt.Sprintf(`"DocumentChunk"."contentType" = ANY($%d)`, argIdx))
		baseArgs = append(baseArgs, req.ContentTypes)
		argIdx++
	}

	if req.Version != "" {
		// 版本过滤收紧：精确 = 与前缀 v% 两档（chunk semVer / repo semVer / branch 同口径）。
		// 废除裸子串 ILIKE '%v%'（"v5" 会误命中 "v15.0.0"/"v50"）；
		// 未标注版本的双 NULL 行放行（历史内容不因缺标签被版本过滤清除）。
		exactIdx := argIdx
		baseArgs = append(baseArgs, req.Version)
		argIdx++
		prefixIdx := argIdx
		baseArgs = append(baseArgs, req.Version+"%")
		argIdx++
		baseFilters = append(baseFilters, BuildVersionFilterPredicate(exactIdx, prefixIdx))
	}

	var rawRows []rawRepoChunkRow
	seenChunkIDs := make(map[string]bool)

	// Stage 0: Exact Concept / Symbol Match
	cleanQuery := strings.TrimSpace(searchQuery)
	if cleanQuery != "" {
		stage0Limit := safeLimit
		if stage0Limit > 5 {
			stage0Limit = 5
		}
		stage0Args := make([]any, len(baseArgs), len(baseArgs)+3)
		copy(stage0Args, baseArgs)

		conceptIdx := argIdx
		stage0Args = append(stage0Args, cleanQuery)

		slugIdx := argIdx + 1
		slug := mdpat.Slugify(cleanQuery)
		if slug == "" {
			slug = strings.ToLower(cleanQuery)
		}
		stage0Args = append(stage0Args, slug)

		limitIdx := argIdx + 2
		stage0Args = append(stage0Args, stage0Limit)

		querySQL := buildStage0ConceptSQL(searchFromJoin, baseFilters, conceptIdx, slugIdx, limitIdx)

		rows, err := s.pool.Query(ctx, querySQL, stage0Args...)
		if err == nil {
			v := 1.0
			appendRepoChunkRows(rows, 0, &v, seenChunkIDs, &rawRows)
			rows.Close()
		}
	}

	// Stage 1: FTS
	if tsQueryStr != "" {
		ftsArgs := make([]any, len(baseArgs), len(baseArgs)+2)
		copy(ftsArgs, baseArgs)

		tsIdx := argIdx
		ftsArgs = append(ftsArgs, tsQueryStr)

		limitIdx := argIdx + 1
		ftsArgs = append(ftsArgs, safeLimit)

		querySQL := fmt.Sprintf(`
			SELECT "DocumentChunk"."id" AS chunk_id,
			       "Document"."id" AS doc_id,
			       "DocumentChunk"."heading",
			       "DocumentChunk"."headingPath",
			       "DocumentChunk"."content",
			       "Document"."title",
			       "Document"."path",
			       COALESCE("Repository"."edition", '') AS repo_edition,
			       COALESCE("Repository"."repoProfile"::text, '{}') AS repo_profile,
			       ts_rank("DocumentChunk"."searchVector", to_tsquery('%s'::regconfig, $%d))::float8 AS fts_rank
			%s
			WHERE %s
			  AND "DocumentChunk"."searchVector" @@ to_tsquery('%s'::regconfig, $%d)
			ORDER BY fts_rank DESC, "DocumentChunk"."id" ASC
			LIMIT $%d`,
			ftsLanguage, tsIdx,
			searchFromJoin,
			strings.Join(baseFilters, " AND "),
			ftsLanguage, tsIdx,
			limitIdx,
		)

		rows, err := s.pool.Query(ctx, querySQL, ftsArgs...)
		if err == nil {
			appendRepoChunkRows(rows, 1, nil, seenChunkIDs, &rawRows)
			rows.Close()
		}
	}

	// Stage 2: Substring fallback
	if len(rawRows) == 0 {
		subArgs := make([]any, len(baseArgs), len(baseArgs)+2)
		copy(subArgs, baseArgs)

		likeIdx := argIdx
		subArgs = append(subArgs, "%"+fallbackQuery+"%")

		limitIdx := argIdx + 1
		subArgs = append(subArgs, safeLimit)

		contentCond := ""
		if len([]rune(fallbackQuery)) >= 3 {
			contentCond = fmt.Sprintf(`OR (length("DocumentChunk"."content") < 5000 AND "DocumentChunk"."content" ILIKE $%d)`, likeIdx)
		}

		querySQL := fmt.Sprintf(`
			SELECT "DocumentChunk"."id" AS chunk_id,
			       "Document"."id" AS doc_id,
			       "DocumentChunk"."heading",
			       "DocumentChunk"."headingPath",
			       "DocumentChunk"."content",
			       "Document"."title",
			       "Document"."path",
			       COALESCE("Repository"."edition", '') AS repo_edition,
			       COALESCE("Repository"."repoProfile"::text, '{}') AS repo_profile,
			       0.5::float8 AS fts_rank
			%s
			WHERE %s
			  AND (
			    ("DocumentChunk"."heading" ILIKE $%d)
			    OR ("Document"."title" ILIKE $%d)
			    OR ("Document"."path" ILIKE $%d)
			    %s
			  )
			ORDER BY "DocumentChunk"."id" ASC
			LIMIT $%d`,
			searchFromJoin,
			strings.Join(baseFilters, " AND "),
			likeIdx, likeIdx, likeIdx,
			contentCond,
			limitIdx,
		)

		rows, err := s.pool.Query(ctx, querySQL, subArgs...)
		if err == nil {
			v := 0.5
			appendRepoChunkRows(rows, 2, &v, seenChunkIDs, &rawRows)
			rows.Close()
		}
	}

	// Stage 3: Multi-token fallback
	if len(rawRows) == 0 {
		tokens := extractSearchTokens(fallbackQuery)
		if len(tokens) > 1 {
			tokArgs := make([]any, len(baseArgs))
			copy(tokArgs, baseArgs)

			var tokConds []string
			currIdx := argIdx
			for _, tok := range tokens {
				tokArgs = append(tokArgs, "%"+tok+"%")
				
				contentCond := ""
				if len([]rune(tok)) >= 3 {
					contentCond = fmt.Sprintf(`OR (length("DocumentChunk"."content") < 5000 AND "DocumentChunk"."content" ILIKE $%d)`, currIdx)
				}
				
				tokConds = append(tokConds, fmt.Sprintf(
					`("DocumentChunk"."heading" ILIKE $%d OR "Document"."title" ILIKE $%d %s)`,
					currIdx, currIdx, contentCond,
				))
				currIdx++
			}

			limitIdx := currIdx
			tokArgs = append(tokArgs, safeLimit)

			querySQL := fmt.Sprintf(`
				SELECT "DocumentChunk"."id" AS chunk_id,
				       "Document"."id" AS doc_id,
				       "DocumentChunk"."heading",
				       "DocumentChunk"."headingPath",
				       "DocumentChunk"."content",
				       "Document"."title",
				       "Document"."path",
				       COALESCE("Repository"."edition", '') AS repo_edition,
				       COALESCE("Repository"."repoProfile"::text, '{}') AS repo_profile,
				       0.3::float8 AS fts_rank
				%s
				WHERE %s
				  AND (%s)
				ORDER BY "DocumentChunk"."id" ASC
				LIMIT $%d`,
				searchFromJoin,
				strings.Join(baseFilters, " AND "),
				strings.Join(tokConds, " OR "),
				limitIdx,
			)

			rows, err := s.pool.Query(ctx, querySQL, tokArgs...)
			if err == nil {
				appendMultiTokenRows(rows, tokens, seenChunkIDs, &rawRows)
				rows.Close()
			}
		}
	}

	rawRows = rerankRepoChunkRows(rawRows, ogis.DefaultTopologicalScorer)
	hits := make([]SearchChunkHit, 0, min(safeLimit, len(rawRows)))
	// 同仓所有行的 repoProfile 相同：按字节串缓存一次解析（纯函数，逐位一致）
	editionLabelCache := make(map[string]string)
	cumulativeTokens := 0
	for _, r := range rawRows {
		if len(hits) >= safeLimit {
			break
		}
		textLen := len([]rune(r.Content))
		estTokens := int(math.Ceil(float64(textLen) * 0.25))
		if req.TokenBudget > 0 && cumulativeTokens+estTokens > req.TokenBudget && len(hits) > 0 {
			break
		}
		cumulativeTokens += estTokens

		rawTitle := ""
		if r.Title != nil {
			rawTitle = *r.Title
		}
		title := ogis.ResolveDocTitle(rawTitle, r.Path, r.Content)
		snippet := ogis.ExtractContextSnippet(r.Content, fallbackQuery, snippetLen)

		var sim float64
		switch {
		case r.Stage == 0:
			sim = 1.0
		case r.MatchCount != nil:
			sim = math.Min(0.95, 0.5+float64(*r.MatchCount)*0.1)
		case r.FtsRank != nil:
			sim = *r.FtsRank
		default:
			sim = 0.5
		}
		if r.Stage != 0 {
			mult := ogis.DefaultTopologicalScorer.ScorePath(r.Path)
			sim = math.Min(0.95, math.Max(0.1, sim*mult))
		}
		if sim < 0.1 {
			sim = 0.1
		} else if sim > 1.0 {
			sim = 1.0
		}

		var editionLabel *string
		if r.RepoEdition != "" {
			lbl, cached := editionLabelCache[string(r.RepoProfile)]
			if !cached {
				lbl = deriveEditionLabel(r.RepoProfile)
				editionLabelCache[string(r.RepoProfile)] = lbl
			}
			editionLabel = &lbl
		}

		hit := SearchChunkHit{
			ChunkID:      r.ChunkID,
			DocID:        r.DocID,
			Title:        title,
			Path:         r.Path,
			Heading:      r.Heading,
			HeadingPath:  r.HeadingPath,
			Snippet:      snippet,
			Similarity:   sim,
			EditionLabel: editionLabel,
			MatchCount:   r.MatchCount,
			FtsRank:      r.FtsRank,
		}

		if req.IncludeContent {
			hit.Content = r.Content
		}

		hits = append(hits, hit)
	}

	return hits, nil
}

func (s *PgxStore) SearchGlobalChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("pgx pool is nil")
	}
	query := strings.TrimSpace(req.Query)
	if query == "" {
		query = strings.TrimSpace(req.RawQuery)
	}
	if query == "" {
		return []SearchChunkHit{}, nil
	}

	safeLimit := req.Limit
	if safeLimit <= 0 {
		safeLimit = 15
	} else if safeLimit > 60 {
		safeLimit = 60
	}

	snippetLen := req.SnippetMaxLen
	if snippetLen <= 0 {
		snippetLen = 100
	}

	ftsLanguage := getFtsLanguageConfig(req.Locale)
	tsQueryStr := buildTsQuery(query)

	var baseArgs []any
	baseFilters := []string{
		`"Document"."status" = 'PROCESSED'`,
		`"Repository"."isPublic" = true`,
	}
	argIdx := 1
	userArgIdx := 0

	if req.UserID != nil && *req.UserID != "" {
		userArgIdx = argIdx
		baseFilters = append(baseFilters, fmt.Sprintf(`("Document"."ownerUserId" IS NULL OR "Document"."ownerUserId" = $%d)`, argIdx))
		baseArgs = append(baseArgs, *req.UserID)
		argIdx++
	} else {
		baseFilters = append(baseFilters, `"Document"."ownerUserId" IS NULL`)
	}

	searchFromJoin := buildGlobalSearchFromJoin(userArgIdx)

	var rawRows []rawGlobalChunkRow
	seenChunkIDs := make(map[string]bool)

	// Stage 0: Global Exact Concept / Symbol Match
	cleanQuery := strings.TrimSpace(query)
	if cleanQuery != "" {
		stage0Limit := safeLimit
		if stage0Limit > 5 {
			stage0Limit = 5
		}
		stage0Args := make([]any, len(baseArgs), len(baseArgs)+3)
		copy(stage0Args, baseArgs)

		conceptIdx := argIdx
		stage0Args = append(stage0Args, cleanQuery)

		slugIdx := argIdx + 1
		slug := mdpat.Slugify(cleanQuery)
		if slug == "" {
			slug = strings.ToLower(cleanQuery)
		}
		stage0Args = append(stage0Args, slug)

		limitIdx := argIdx + 2
		stage0Args = append(stage0Args, stage0Limit)

		querySQL := buildGlobalStage0ConceptSQL(searchFromJoin, baseFilters, conceptIdx, slugIdx, limitIdx)

		rows, err := s.pool.Query(ctx, querySQL, stage0Args...)
		if err == nil {
			v := 1.0
			appendGlobalChunkRows(rows, 0, &v, seenChunkIDs, &rawRows)
			rows.Close()
		}
	}

	// Stage 1: Global FTS
	if tsQueryStr != "" {
		ftsArgs := make([]any, len(baseArgs), len(baseArgs)+2)
		copy(ftsArgs, baseArgs)

		tsIdx := argIdx
		ftsArgs = append(ftsArgs, tsQueryStr)

		limitIdx := argIdx + 1
		ftsArgs = append(ftsArgs, safeLimit)

		querySQL := fmt.Sprintf(`
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
			       ts_rank("DocumentChunk"."searchVector", to_tsquery('%s'::regconfig, $%d))::float8 AS fts_rank
			%s
			WHERE %s
			  AND "DocumentChunk"."searchVector" @@ to_tsquery('%s'::regconfig, $%d)
			ORDER BY fts_rank DESC, "DocumentChunk"."id" ASC
			LIMIT $%d`,
			ftsLanguage, tsIdx,
			searchFromJoin,
			strings.Join(baseFilters, " AND "),
			ftsLanguage, tsIdx,
			limitIdx,
		)

		rows, err := s.pool.Query(ctx, querySQL, ftsArgs...)
		if err == nil {
			appendGlobalChunkRows(rows, 1, nil, seenChunkIDs, &rawRows)
			rows.Close()
		}
	}

	// Stage 2: Global substring fallback
	if len(rawRows) == 0 {
		subArgs := make([]any, len(baseArgs), len(baseArgs)+2)
		copy(subArgs, baseArgs)

		likeIdx := argIdx
		subArgs = append(subArgs, "%"+query+"%")

		limitIdx := argIdx + 1
		subArgs = append(subArgs, safeLimit)

		contentCond := ""
		if len([]rune(query)) >= 3 {
			contentCond = fmt.Sprintf(`OR (length("DocumentChunk"."content") < 5000 AND "DocumentChunk"."content" ILIKE $%d)`, likeIdx)
		}

		querySQL := fmt.Sprintf(`
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
			       0.4::float8 AS fts_rank
			%s
			WHERE %s
			  AND (
			    ("DocumentChunk"."heading" ILIKE $%d)
			    OR ("Document"."title" ILIKE $%d)
			    OR ("Document"."path" ILIKE $%d)
			    %s
			  )
			ORDER BY "DocumentChunk"."id" ASC
			LIMIT $%d`,
			searchFromJoin,
			strings.Join(baseFilters, " AND "),
			likeIdx, likeIdx, likeIdx,
			contentCond,
			limitIdx,
		)

		rows, err := s.pool.Query(ctx, querySQL, subArgs...)
		if err == nil {
			v := 0.4
			appendGlobalChunkRows(rows, 2, &v, seenChunkIDs, &rawRows)
			rows.Close()
		}
	}

	rawRows = rerankGlobalChunkRows(rawRows, ogis.DefaultTopologicalScorer)
	hits := make([]SearchChunkHit, 0, min(safeLimit, len(rawRows)))
	// 同仓所有行的 repoProfile 相同：按字节串缓存一次解析（纯函数，逐位一致）
	editionLabelCache := make(map[string]string)
	cumulativeTokens := 0
	for _, r := range rawRows {
		if len(hits) >= safeLimit {
			break
		}
		textLen := len([]rune(r.Content))
		estTokens := int(math.Ceil(float64(textLen) * 0.25))
		if req.TokenBudget > 0 && cumulativeTokens+estTokens > req.TokenBudget && len(hits) > 0 {
			break
		}
		cumulativeTokens += estTokens

		rawTitle := ""
		if r.Title != nil {
			rawTitle = *r.Title
		}
		title := ogis.ResolveDocTitle(rawTitle, r.Path, r.Content)
		snippet := ogis.ExtractContextSnippet(r.Content, query, snippetLen)
		sim := 0.4
		if r.Stage == 0 {
			sim = 1.0
		} else if r.FtsRank != nil {
			sim = *r.FtsRank
		}
		if r.Stage != 0 {
			mult := ogis.DefaultTopologicalScorer.ScorePath(r.Path)
			sim = math.Min(0.95, math.Max(0.1, sim*mult))
		}
		if sim < 0.1 {
			sim = 0.1
		} else if sim > 1.0 {
			sim = 1.0
		}

		var editionLabel *string
		if r.RepoEdition != "" {
			lbl, cached := editionLabelCache[string(r.RepoProfile)]
			if !cached {
				lbl = deriveEditionLabel(r.RepoProfile)
				editionLabelCache[string(r.RepoProfile)] = lbl
			}
			editionLabel = &lbl
		}

		hit := SearchChunkHit{
			ChunkID:      r.ChunkID,
			DocID:        r.DocID,
			Title:        title,
			Path:         r.Path,
			Heading:      r.Heading,
			HeadingPath:  r.HeadingPath,
			Snippet:      snippet,
			Similarity:   sim,
			Owner:        r.RepoOwner,
			Repo:         r.RepoName,
			EditionLabel: editionLabel,
			MatchCount:   r.MatchCount,
			FtsRank:      r.FtsRank,
		}

		if req.IncludeContent {
			hit.Content = r.Content
		}

		hits = append(hits, hit)
	}

	return hits, nil
}
