package mcp

import (
	"time"

	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

func toRepoRow(id, owner, repo, branch, edition string, semVerLabel pgtype.Text, mcpStatus string, category pgtype.Text, isPublic bool, navTree, repoProfile []byte) *RepoRow {
	var sv *string
	if semVerLabel.Valid {
		sv = &semVerLabel.String
	}
	cat := ""
	if category.Valid {
		cat = category.String
	}
	return &RepoRow{
		ID:          id,
		Owner:       owner,
		Repo:        repo,
		Branch:      branch,
		Edition:     edition,
		SemVerLabel: sv,
		McpStatus:   mcpStatus,
		Category:    cat,
		IsPublic:    isPublic,
		NavTree:     json.RawMessage(navTree),
		RepoProfile: json.RawMessage(repoProfile),
	}
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t' || s[0] == '\n' || s[0] == '\r') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t' || s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

func (s *pgxStore) FindDefaultBranchRepo(ctx context.Context, owner, repo, defaultBranch string) (*RepoRow, error) {
	r, err := db.New(s.pool).MCPFindDefaultBranchRepo(ctx, db.MCPFindDefaultBranchRepoParams{
		Owner:  owner,
		Repo:   repo,
		Branch: defaultBranch,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return toRepoRow(r.ID, r.Owner, r.Repo, r.Branch, r.Edition, r.SemVerLabel, r.McpStatus, r.Category, r.IsPublic, r.NavTree, r.RepoProfile), nil
}

func (s *pgxStore) HasSavedRepoAccess(ctx context.Context, repositoryID, userID string) (bool, error) {
	one, err := db.New(s.pool).MCPHasSavedRepoAccess(ctx, db.MCPHasSavedRepoAccessParams{
		RepositoryId: repositoryID,
		UserId:       userID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return one == 1, err
}

// Key resolveCache by userID because private document copies are isolated per ownerUserId.
var resolveCache = newTTLCache(60*time.Second, 1024)

func (s *pgxStore) ResolveSingleRepo(ctx context.Context, owner, repo, defaultBranch, edition, userID string) (*ResolvedRepo, error) {
	cacheKey := strings.ToLower(owner) + "|" + strings.ToLower(repo) + "|" + defaultBranch + "|" + edition + "|" + userID
	v, err := resolveCache.getOrLoadWithCustomTTL(cacheKey, func() (any, time.Duration, error) {
		resolved, qerr := s.resolveSingleRepoUncached(ctx, owner, repo, defaultBranch, edition, userID)
		if qerr != nil {
			return nil, 0, qerr
		}
		if resolved == nil {
			return (any)(nil), 10 * time.Second, nil // Negative-cache misses for 10s to absorb repo-enumeration scans.
		}
		return resolved, 60 * time.Second, nil
	})
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	return v.(*ResolvedRepo), nil
}

func (s *pgxStore) resolveSingleRepoUncached(ctx context.Context, owner, repo, defaultBranch, edition, userID string) (*ResolvedRepo, error) {

	ownerT, repoT := strings.ToLower(trimSpace(owner)), strings.ToLower(trimSpace(repo))
	wantedEdition := edition

	var row *RepoRow
	var err error
	q := db.New(s.pool)
	switch {
	case ownerT == "personal" || ownerT == "default":
		r, qerr := q.MCPResolveRepoPersonal(ctx, db.MCPResolveRepoPersonalParams{
			Repo:    repoT,
			Edition: wantedEdition,
		})
		if qerr == nil {
			row = toRepoRow(r.ID, r.Owner, r.Repo, r.Branch, r.Edition, r.SemVerLabel, r.McpStatus, r.Category, r.IsPublic, r.NavTree, r.RepoProfile)
		} else if !errors.Is(qerr, pgx.ErrNoRows) {
			err = qerr
		}
	default:
		r, qerr := q.MCPResolveRepoBranchEdition(ctx, db.MCPResolveRepoBranchEditionParams{
			Owner:   ownerT,
			Repo:    repoT,
			Branch:  defaultBranch,
			Edition: wantedEdition,
		})
		if qerr == nil {
			row = toRepoRow(r.ID, r.Owner, r.Repo, r.Branch, r.Edition, r.SemVerLabel, r.McpStatus, r.Category, r.IsPublic, r.NavTree, r.RepoProfile)
		} else if errors.Is(qerr, pgx.ErrNoRows) {
			r2, qerr2 := q.MCPResolveRepoEdition(ctx, db.MCPResolveRepoEditionParams{
				Owner:   ownerT,
				Repo:    repoT,
				Edition: wantedEdition,
			})
			if qerr2 == nil {
				row = toRepoRow(r2.ID, r2.Owner, r2.Repo, r2.Branch, r2.Edition, r2.SemVerLabel, r2.McpStatus, r2.Category, r2.IsPublic, r2.NavTree, r2.RepoProfile)
			} else if !errors.Is(qerr2, pgx.ErrNoRows) {
				err = qerr2
			}
		} else {
			err = qerr
		}
	}
	if err != nil {
		return nil, err
	}
	if row == nil && wantedEdition != "" {
		return s.ResolveSingleRepo(ctx, owner, repo, defaultBranch, "", userID)
	}
	if row == nil {
		return nil, nil
	}

	docs, err := s.listRepoDocuments(ctx, row.ID, userID)
	if err != nil {
		return nil, err
	}

	targetLabel := row.SemVerLabel
	if targetLabel == nil || *targetLabel == "" {
		targetLabel = &row.Branch
	}
	return &ResolvedRepo{Repository: *row, Documents: docs, TargetVersionLabel: targetLabel}, nil
}

func (s *pgxStore) listRepoDocuments(ctx context.Context, repositoryID, userID string) ([]DocMeta, error) {
	rows, err := db.New(s.pool).MCPListRepoDocuments(ctx, db.MCPListRepoDocumentsParams{
		RepositoryId: repositoryID,
		OwnerUserId:  pgtype.Text{String: userID, Valid: userID != ""},
	})
	if err != nil {
		return nil, err
	}
	docs := make([]DocMeta, 0, len(rows))
	for _, r := range rows {
		title := ""
		if r.Title.Valid {
			title = r.Title.String
		}
		var summary *string
		if r.Summary.Valid {
			summary = &r.Summary.String
		}
		docs = append(docs, DocMeta{
			ID:      r.ID,
			Path:    r.Path,
			Title:   title,
			Summary: summary,
		})
	}
	return docs, nil
}

func (s *pgxStore) FindDocContent(ctx context.Context, repositoryID, docID, userID string) (*string, error) {
	row, err := db.New(s.pool).MCPFindDocContent(ctx, db.MCPFindDocContentParams{
		ID:           docID,
		RepositoryId: repositoryID,
		OwnerUserId:  pgtype.Text{String: userID, Valid: userID != ""},
	})
	if errors.Is(err, pgx.ErrNoRows) || err != nil {
		return nil, nil
	}

	if row.LayeredContent.Valid && row.LayeredContent.String != "" {
		return &row.LayeredContent.String, nil
	}
	if row.LegacyContent.Valid {
		return &row.LegacyContent.String, nil
	}
	return nil, nil
}

func (s *pgxStore) FindBundleDoc(ctx context.Context, repositoryID, path string) (string, string, string, bool, error) {
	row, err := db.New(s.pool).MCPFindBundleDoc(ctx, db.MCPFindBundleDocParams{
		RepositoryId: repositoryID,
		Lower:        path,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", false, nil
	}
	if err != nil {
		return "", "", "", false, err
	}
	actualTitle := ""
	if row.Title.Valid {
		actualTitle = row.Title.String
	}
	actualPath := path
	if row.Path != "" {
		actualPath = row.Path
	}
	actualContent := ""
	if row.LayeredContent.Valid && row.LayeredContent.String != "" {
		actualContent = row.LayeredContent.String
	} else if row.LegacyContent.Valid {
		actualContent = row.LegacyContent.String
	}
	if actualContent == "" {
		return actualTitle, actualPath, "", false, nil
	}
	return actualTitle, actualPath, actualContent, true, nil
}

func (s *pgxStore) ListChunksByDoc(ctx context.Context, docID string) ([]Chunk, error) {
	rows, err := db.New(s.pool).MCPListChunksByDoc(ctx, pgtype.Text{String: docID, Valid: docID != ""})
	if err != nil {
		return nil, nil
	}
	chunks := make([]Chunk, 0, len(rows))
	for _, r := range rows {
		var h, hp, sv *string
		if r.Heading.Valid {
			h = &r.Heading.String
		}
		if r.HeadingPath.Valid {
			hp = &r.HeadingPath.String
		}
		if r.SemVerLabel.Valid {
			sv = &r.SemVerLabel.String
		}
		chunks = append(chunks, Chunk{
			Heading:     h,
			HeadingPath: hp,
			Content:     r.Content,
			SemVerLabel: sv,
		})
	}
	return chunks, nil
}

func (s *pgxStore) ListChunkHeadings(ctx context.Context, docID string, take int) ([]ChunkHeading, error) {
	rows, err := db.New(s.pool).MCPListChunkHeadings(ctx, db.MCPListChunkHeadingsParams{
		DocumentId: pgtype.Text{String: docID, Valid: docID != ""},
		Limit:      int32(take),
	})
	if err != nil {
		return nil, nil
	}
	out := make([]ChunkHeading, 0, len(rows))
	for _, r := range rows {
		var h, hp *string
		if r.Heading.Valid {
			h = &r.Heading.String
		}
		if r.HeadingPath.Valid {
			hp = &r.HeadingPath.String
		}
		ct := r.ContentType
		out = append(out, ChunkHeading{
			Heading:     h,
			HeadingPath: hp,
			ContentType: &ct,
		})
	}
	return out, nil
}

func (s *pgxStore) GetRepoGitSha(ctx context.Context, repositoryID string) (owner, repo, sha string, ok bool) {
	row, err := db.New(s.pool).MCPGetRepoGitSha(ctx, repositoryID)
	if err != nil || !row.GitSha.Valid || row.GitSha.String == "" {
		return "", "", "", false
	}
	return row.Owner, row.Repo, row.GitSha.String, true
}

func (s *pgxStore) LoadSemanticGraph(ctx context.Context, owner, repo, sha string) (*rsg.SemanticGraphArtifact, error) {
	if s == nil || s.pool == nil {
		return nil, nil
	}
	return rsg.NewPgGraphStore(s.pool).LoadArtifact(ctx, owner, repo, sha)
}

func (s *pgxStore) HasPrivateDocs(ctx context.Context, repositoryID, userID string) bool {
	if userID == "" || repositoryID == "" {
		return false
	}
	one, err := db.New(s.pool).MCPHasPrivateDocs(ctx, db.MCPHasPrivateDocsParams{
		RepositoryId: repositoryID,
		OwnerUserId:  pgtype.Text{String: userID, Valid: true},
	})
	return err == nil && one == 1
}
