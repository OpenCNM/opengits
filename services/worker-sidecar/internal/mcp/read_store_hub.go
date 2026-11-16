package mcp

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// parseHubRef 解析 Hub 引用："owner/repo@edition" / "id@edition" / 普通 "owner/repo" / "id"
func parseHubRef(ref string) (base, edition string) {
	at := strings.LastIndex(ref, "@")
	if at > 0 && at < len(ref)-1 {
		return ref[:at], ref[at+1:]
	}
	return ref, ""
}

func (s *pgxStore) ListUserBookshelfRepos(ctx context.Context, userID string) ([]BookshelfRepoRow, error) {
	rows, err := db.New(s.pool).MCPListUserBookshelfRepos(ctx, userID)
	if err != nil {
		return nil, err
	}

	out := make([]BookshelfRepoRow, 0, len(rows))
	for _, r := range rows {
		repoRow := toRepoRow(r.ID, r.Owner, r.Repo, r.Branch, r.Edition, r.SemVerLabel, r.McpStatus, r.Category, r.IsPublic, r.NavTree, r.RepoProfile)
		out = append(out, BookshelfRepoRow{
			RepoRow:     *repoRow,
			Tags:        r.Tags,
			IsVerified:  r.IsVerified,
			StarCount:   int(r.StarCount),
			BestUsedFor: r.BestUsedFor,
			UpdatedAt:   r.UpdatedAt.Time,
			LastReadAt:  r.LastReadAt.Time,
		})
	}
	return out, nil
}

func (s *pgxStore) ResolveBookshelfRepo(ctx context.Context, userID, ref, edition string) (*ResolvedRepo, error) {
	if ref == "" {
		return nil, nil
	}
	base, refEdition := parseHubRef(ref)
	effectiveEdition := edition
	if effectiveEdition == "" {
		effectiveEdition = refEdition
	}

	parts := strings.Split(base, "/")
	ownerPart := ""
	repoPart := ""
	if len(parts) >= 2 {
		// ToLower 归一对齐存储行小写口径，SQL 侧精确等值（消除 ILIKE 通配逃逸）
		ownerPart = strings.ToLower(strings.TrimSpace(parts[0]))
		repoPart = strings.ToLower(strings.TrimSpace(parts[1]))
	}

	r, err := db.New(s.pool).MCPLookupBookshelfRepo(ctx, db.MCPLookupBookshelfRepoParams{
		UserId:  userID,
		ID:      base,
		Owner:   ownerPart,
		Repo:    repoPart,
		Edition: effectiveEdition,
	})
	if errors.Is(err, pgx.ErrNoRows) || err != nil {
		return nil, err
	}

	repoRow := toRepoRow(r.ID, r.Owner, r.Repo, r.Branch, r.Edition, r.SemVerLabel, r.McpStatus, r.Category, r.IsPublic, r.NavTree, r.RepoProfile)

	docs, err := s.listRepoDocuments(ctx, repoRow.ID, userID)
	if err != nil {
		return nil, err
	}
	targetLabel := repoRow.SemVerLabel
	if targetLabel == nil || *targetLabel == "" {
		targetLabel = &repoRow.Branch
	}
	return &ResolvedRepo{
		Repository:         *repoRow,
		Documents:          docs,
		TargetVersionLabel: targetLabel,
	}, nil
}

func (s *pgxStore) FindConceptAcrossBookshelf(ctx context.Context, userID, query string, limit int) ([]CrossRepoConceptHit, map[string]GlobalConceptMeta, error) {
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return nil, nil, nil
	}
	if limit <= 0 {
		limit = 30
	}

	rows, err := db.New(s.pool).MCPFindConceptAcrossBookshelf(ctx, db.MCPFindConceptAcrossBookshelfParams{
		UserId: userID,
		Query:  trimmed,
		Limit:  int32(limit),
	})
	if err != nil {
		return nil, nil, err
	}

	var hits []CrossRepoConceptHit
	gcIDs := make(map[string]bool)
	for _, r := range rows {
		var gcID, headingPath, docPath *string
		if r.GlobalConceptId.Valid {
			gcID = &r.GlobalConceptId.String
		}
		if r.HeadingPath.Valid {
			headingPath = &r.HeadingPath.String
		}
		if r.DocPath.Valid {
			docPath = &r.DocPath.String
		}
		h := CrossRepoConceptHit{
			ConceptID:       r.ConceptID,
			ConceptName:     r.ConceptName,
			Category:        r.Category,
			GlobalConceptID: gcID,
			DocPath:         docPath,
			HeadingPath:     headingPath,
			RepoID:          r.RepoID,
			RepoOwner:       r.RepoOwner,
			RepoName:        r.RepoName,
		}
		if docPath != nil && headingPath != nil && *docPath != "" && *headingPath != "" {
			h.Address = buildCleanSectionAddress(*docPath, *headingPath)
		}
		if gcID != nil && *gcID != "" {
			gcIDs[*gcID] = true
		}
		hits = append(hits, h)
	}

	gcMap := make(map[string]GlobalConceptMeta)
	if len(gcIDs) > 0 {
		idList := make([]string, 0, len(gcIDs))
		for id := range gcIDs {
			idList = append(idList, id)
		}
		grows, err := db.New(s.pool).MCPGlobalConceptsByIDs(ctx, idList)
		if err == nil {
			for _, gr := range grows {
				gcMap[gr.ID] = GlobalConceptMeta{
					CanonicalName: gr.CanonicalName,
					Aliases:       gr.Aliases,
				}
			}
		}
	}
	return hits, gcMap, nil
}
