package search

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

func (s *PgxStore) SearchUnified(ctx context.Context, req UnifiedSearchRequest) ([]UnifiedSearchHit, error) {
	rawQuery := strings.TrimSpace(req.RawQuery)
	if rawQuery == "" {
		rawQuery = strings.TrimSpace(req.Query)
	}
	if rawQuery == "" {
		return []UnifiedSearchHit{}, nil
	}

	var results []UnifiedSearchHit

	exactOwner := strings.TrimSpace(req.ExactOwner)
	exactRepo := strings.TrimSpace(req.ExactRepo)
	if exactOwner != "" && exactRepo != "" {
		repoRow, err := db.New(s.pool).GetExactRepositoryForSearch(ctx, db.GetExactRepositoryForSearchParams{
			Lower:   exactOwner,
			Lower_2: exactRepo,
		})
		if err == nil {
			id := repoRow.ID
			owner := repoRow.Owner
			repo := repoRow.Repo
			var category *string
			if repoRow.Category.Valid {
				category = &repoRow.Category.String
			}
			bestUsedFor := repoRow.BestUsedFor

			cat := "General"
			if category != nil && strings.TrimSpace(*category) != "" {
				cat = strings.TrimSpace(*category)
			}
			var desc string
			if category != nil && strings.TrimSpace(*category) != "" {
				desc = fmt.Sprintf("%s 开源项目，已生成 AI 教学文档", *category)
			} else if len(bestUsedFor) > 0 {
				desc = strings.Join(bestUsedFor, ", ")
			} else {
				desc = "已生成 AI 教学文档与 MCP 工具包，点击直接进入阅读"
			}
			isIngested := true
			results = append(results, UnifiedSearchHit{
				ID:          fmt.Sprintf("exact-repo-%s", id),
				Type:        "repository_exists",
				IsIngested:  &isIngested,
				Title:       fmt.Sprintf("%s/%s", owner, repo),
				Description: desc,
				Owner:       owner,
				Repo:        repo,
				URL:         fmt.Sprintf("/docs/%s/%s", owner, repo),
				Category:    cat,
				Score:       1000,
			})
		} else {
			isIngested := false
			results = append(results, UnifiedSearchHit{
				ID:          fmt.Sprintf("exact-import-%s-%s", exactOwner, exactRepo),
				Type:        "repository_import_cta",
				IsIngested:  &isIngested,
				Title:       fmt.Sprintf("一键摄入 %s/%s", exactOwner, exactRepo),
				Description: fmt.Sprintf("尚未生成教程。点击即可一键解析 %s/%s 并生成 AI 教学文档", exactOwner, exactRepo),
				Owner:       exactOwner,
				Repo:        exactRepo,
				URL:         fmt.Sprintf("/?importUrl=%s", url.QueryEscape(fmt.Sprintf("https://github.com/%s/%s", exactOwner, exactRepo))),
				Score:       1000,
			})
		}
	}

	ownerParam := strings.TrimSpace(req.Owner)
	repoParam := strings.TrimSpace(req.Repo)
	if ownerParam != "" && repoParam != "" {
		targetRepo, err := db.New(s.pool).GetRepoForInRepoSearch(ctx, db.GetRepoForInRepoSearchParams{
			Lower:   ownerParam,
			Lower_2: repoParam,
		})
		var targetRepoID, targetOwner, targetRepoName string
		if err == nil {
			targetRepoID = targetRepo.ID
			targetOwner = targetRepo.Owner
			targetRepoName = targetRepo.Repo

			tokens := ExtractSearchTokens(rawQuery)
			searchTerms := make([]string, 0, len(tokens)+1)
			seenTerms := make(map[string]bool)
			for _, t := range append([]string{rawQuery}, tokens...) {
				trimmed := strings.TrimSpace(t)
				if trimmed != "" && !seenTerms[trimmed] {
					seenTerms[trimmed] = true
					searchTerms = append(searchTerms, trimmed)
				}
			}

			if len(searchTerms) > 0 {
				conceptSQL, conceptArgs := buildConceptSearchSQL(targetRepoID, req.UserID, searchTerms)
				rows, cErr := s.pool.Query(ctx, conceptSQL, conceptArgs...)
				if cErr == nil {
					defer rows.Close()
					for rows.Next() {
						var cID, cName string
						var cCat, cSummary, cPrinciplesText, cHeadingPath, docPath, docTitle *string
						if scanErr := rows.Scan(&cID, &cName, &cCat, &cSummary, &cPrinciplesText, &cHeadingPath, &docPath, &docTitle); scanErr == nil {
							cat := "Concept"
							if cCat != nil && strings.TrimSpace(*cCat) != "" {
								cat = strings.TrimSpace(*cCat)
							}
							title := fmt.Sprintf("💡 %s", cName)
							if cCat != nil && strings.TrimSpace(*cCat) != "" {
								title = fmt.Sprintf("💡 %s (%s)", cName, *cCat)
							}
							desc := ""
							if cSummary != nil && strings.TrimSpace(*cSummary) != "" {
								desc = *cSummary
							} else if cPrinciplesText != nil && strings.TrimSpace(*cPrinciplesText) != "" {
								desc = *cPrinciplesText
							}
							anchor := ""
							if cHeadingPath != nil && strings.TrimSpace(*cHeadingPath) != "" {
								anchor = "#" + strings.TrimSpace(*cHeadingPath)
							}
							cleanPath := ""
							if docPath != nil {
								cleanPath = strings.TrimSuffix(strings.TrimSuffix(*docPath, ".mdx"), ".md")
							}
							linkURL := fmt.Sprintf("/docs/%s/%s", targetOwner, targetRepoName)
							if cleanPath != "" {
								linkURL = fmt.Sprintf("/docs/%s/%s/%s%s", targetOwner, targetRepoName, cleanPath, anchor)
							}
							isIngested := true
							results = append(results, UnifiedSearchHit{
								ID:          fmt.Sprintf("concept-%s", cID),
								Type:        "document",
								IsIngested:  &isIngested,
								Title:       title,
								Description: desc,
								Owner:       targetOwner,
								Repo:        targetRepoName,
								Category:    cat,
								URL:         linkURL,
								Score:       200,
							})
						}
					}
				}
			}

			chunkHits, chErr := s.SearchRepositoryChunks(ctx, SearchChunksRequest{
				RepositoryID: targetRepoID,
				Query:        rawQuery,
				RawQuery:     rawQuery,
				Limit:        30,
				UserID:       req.UserID,
			})
			if chErr == nil {
				bestByPath := make(map[string]SearchChunkHit)
				for _, h := range chunkHits {
					prev, ok := bestByPath[h.Path]
					if !ok || h.Similarity > prev.Similarity {
						bestByPath[h.Path] = h
					}
				}
				for _, h := range bestByPath {
					anchor := ""
					if h.HeadingPath != nil && strings.TrimSpace(*h.HeadingPath) != "" {
						anchor = "#" + strings.TrimSpace(*h.HeadingPath)
					}
					cleanPath := strings.TrimSuffix(strings.TrimSuffix(h.Path, ".mdx"), ".md")
					linkURL := fmt.Sprintf("/docs/%s/%s/%s%s", targetOwner, targetRepoName, cleanPath, anchor)
					score := 50 + int(math.Round(math.Min(1, h.Similarity)*50))
					isIngested := true
					results = append(results, UnifiedSearchHit{
						ID:          fmt.Sprintf("doc-%s-%s-%s", targetOwner, targetRepoName, h.Path),
						Type:        "document",
						IsIngested:  &isIngested,
						Title:       h.Title,
						Description: h.Snippet,
						Owner:       targetOwner,
						Repo:        targetRepoName,
						URL:         linkURL,
						Score:       score,
					})
				}
			}
		}

		return sortAndLimitHits(results, req.Limit), nil
	}

	queryLower := strings.ToLower(rawQuery)

	repoPrefix := rawQuery + "%"
	repoPattern := "%" + rawQuery + "%"
	fuzzyRepoRows, rErr := db.New(s.pool).SearchPublicRepositoriesByFuzzy(ctx, db.SearchPublicRepositoriesByFuzzyParams{
		Owner:    repoPrefix,
		Category: pgtype.Text{String: repoPattern, Valid: true},
	})
	if rErr == nil {
		for _, repoRow := range fuzzyRepoRows {
			rID := repoRow.ID
			rOwner := repoRow.Owner
			rRepo := repoRow.Repo
			var rCategory *string
			if repoRow.Category.Valid {
				rCategory = &repoRow.Category.String
			}
			rBestUsedFor := repoRow.BestUsedFor

			alreadyListed := false
			for _, existing := range results {
				if strings.EqualFold(existing.Owner, rOwner) && strings.EqualFold(existing.Repo, rRepo) {
					alreadyListed = true
					break
				}
			}
			if !alreadyListed {
				score := 100
				rRepoLower := strings.ToLower(rRepo)
				if rRepoLower == queryLower {
					score += 200
				}
				if strings.Contains(rRepoLower, queryLower) {
					score += 100
				}

				desc := "开源项目教学文档与 MCP 服务"
				if rCategory != nil && strings.TrimSpace(*rCategory) != "" {
					desc = fmt.Sprintf("%s 开源项目", strings.TrimSpace(*rCategory))
				} else if len(rBestUsedFor) > 0 {
					desc = strings.Join(rBestUsedFor, ", ")
				}
				cat := "General"
				if rCategory != nil && strings.TrimSpace(*rCategory) != "" {
					cat = strings.TrimSpace(*rCategory)
				}
				isIngested := true
				results = append(results, UnifiedSearchHit{
					ID:          fmt.Sprintf("repo-%s", rID),
					Type:        "repository_exists",
					IsIngested:  &isIngested,
					Title:       fmt.Sprintf("%s/%s", rOwner, rRepo),
					Description: desc,
					Owner:       rOwner,
					Repo:        rRepo,
					URL:         fmt.Sprintf("/docs/%s/%s", rOwner, rRepo),
					Category:    cat,
					Score:       score,
				})
			}
		}
	}

	bundlePattern := "%" + rawQuery + "%"
	bundleRows, bErr := db.New(s.pool).SearchPublicBundlesByFuzzy(ctx, bundlePattern)
	if bErr == nil {
		for _, bRow := range bundleRows {
			bID := bRow.ID
			bTitle := bRow.Title
			bDescription := bRow.Description
			bOwner := bRow.Owner
			bRepo := bRow.Repo
			desc := "AI 教程与 MCP 工具合集包"
			if strings.TrimSpace(bDescription) != "" {
				desc = strings.TrimSpace(bDescription)
			}
			isIngested := true
			results = append(results, UnifiedSearchHit{
				ID:          fmt.Sprintf("bundle-%s", bID),
				Type:        "bundle",
				IsIngested:  &isIngested,
				Title:       bTitle,
				Description: desc,
				URL:         fmt.Sprintf("/docs/%s/%s", bOwner, bRepo),
				Category:    "Bundle",
				Score:       80,
			})
		}
	}

	globalHits, gErr := s.SearchGlobalChunks(ctx, SearchChunksRequest{
		IsGlobal: true,
		Query:    rawQuery,
		RawQuery: rawQuery,
		Limit:    30,
		UserID:   req.UserID,
	})
	if gErr == nil {
		seenDocKeys := make(map[string]bool)
		for _, hit := range globalHits {
			owner := hit.Owner
			repo := hit.Repo
			docKey := fmt.Sprintf("%s/%s/%s", owner, repo, hit.Path)
			docID := fmt.Sprintf("doc-%s-%s-%s", owner, repo, hit.Path)

			repoAlreadyListed := false
			idAlreadyListed := false
			for _, existing := range results {
				if strings.EqualFold(existing.Owner, owner) && strings.EqualFold(existing.Repo, repo) && existing.Type == "repository_exists" {
					repoAlreadyListed = true
				}
				if existing.ID == docID {
					idAlreadyListed = true
				}
			}

			if !seenDocKeys[docKey] && !idAlreadyListed && !repoAlreadyListed {
				seenDocKeys[docKey] = true
				cleanPath := strings.TrimSuffix(strings.TrimSuffix(hit.Path, ".mdx"), ".md")
				linkURL := fmt.Sprintf("/docs/%s/%s/%s", owner, repo, cleanPath)
				score := 30 + int(math.Round(math.Min(1, hit.Similarity)*50))
				isIngested := true
				results = append(results, UnifiedSearchHit{
					ID:          docID,
					Type:        "document",
					IsIngested:  &isIngested,
					Title:       hit.Title,
					Description: hit.Snippet,
					Owner:       owner,
					Repo:        repo,
					URL:         linkURL,
					Score:       score,
				})
			}
		}
	}

	return sortAndLimitHits(results, req.Limit), nil
}

func sortAndLimitHits(hits []UnifiedSearchHit, limit int) []UnifiedSearchHit {
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].Title < hits[j].Title
	})
	if limit <= 0 {
		limit = 15
	}
	if len(hits) > limit {
		return hits[:limit]
	}
	return hits
}
