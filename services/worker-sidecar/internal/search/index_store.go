package search

import (
	"context"
	"errors"

	"github.com/opengits/worker-sidecar/internal/platform/db"
)

var errNotExist = errors.New("not found")

// OGISChunkRow 索引打包所需的最小 chunk 投影。
type OGISChunkRow struct {
	ChunkID     string
	Heading     *string
	HeadingPath *string
	Content     string
	Title       *string
	Path        *string
	Order       *int32
}

// OGISRepoMeta 仓库索引元数据。
type OGISRepoMeta struct {
	ID     string
	Owner  string
	Repo   string
	GitSha *string
}

// IndexStore 索引构建数据访问（接口化供测试 fake）。
type IndexStore interface {
	RepoMetaForIndex(ctx context.Context, repoId string) (*OGISRepoMeta, error)
	OGISChunkRowsForRepo(ctx context.Context, repoId string) ([]OGISChunkRow, error)
	ReposWithProcessedDocs(ctx context.Context) ([]OGISRepoMeta, error)
}

// SearchIndexStore 兼容别名。
type SearchIndexStore = IndexStore

func (s *PgxStore) RepoMetaForIndex(ctx context.Context, repoId string) (*OGISRepoMeta, error) {
	m, err := db.New(s.pool).SearchRepoMetaForIndex(ctx, repoId)
	if err != nil {
		return nil, err
	}
	return &OGISRepoMeta{
		ID:     m.ID,
		Owner:  m.Owner,
		Repo:   m.Repo,
		GitSha: func() *string { if m.GitSha.Valid { return &m.GitSha.String } else { return nil } }(),
	}, nil
}

func (s *PgxStore) OGISChunkRowsForRepo(ctx context.Context, repoId string) ([]OGISChunkRow, error) {
	rows, err := db.New(s.pool).SearchOGISChunkRowsForRepo(ctx, repoId)
	if err != nil {
		return nil, err
	}
	var out []OGISChunkRow
	for _, r := range rows {
		out = append(out, OGISChunkRow{
			ChunkID:     r.ID,
			Heading:     func() *string { if r.Heading.Valid { return &r.Heading.String } else { return nil } }(),
			HeadingPath: func() *string { if r.HeadingPath.Valid { return &r.HeadingPath.String } else { return nil } }(),
			Content:     r.Content,
			Title:       func() *string { if r.Title.Valid { return &r.Title.String } else { return nil } }(),
			Path:        func() *string { p := r.Path; return &p }(),
			Order:       func() *int32 { if r.Order.Valid { return &r.Order.Int32 } else { return nil } }(),
		})
	}
	return out, nil
}

func (s *PgxStore) ReposWithProcessedDocs(ctx context.Context) ([]OGISRepoMeta, error) {
	rows, err := db.New(s.pool).SearchReposWithProcessedDocs(ctx)
	if err != nil {
		return nil, err
	}
	var out []OGISRepoMeta
	for _, m := range rows {
		out = append(out, OGISRepoMeta{
			ID:     m.ID,
			Owner:  m.Owner,
			Repo:   m.Repo,
			GitSha: func() *string { if m.GitSha.Valid { return &m.GitSha.String } else { return nil } }(),
		})
	}
	return out, nil
}

// AssetKeyForIndex 与 Node assetObjectKey 对齐：
// assets/{owner}/{repo}/search-index-{gitSha||'head'}.bin。
func AssetKeyForIndex(owner, repo, gitSha string) string {
	if gitSha == "" {
		gitSha = "head"
	}
	return "assets/" + owner + "/" + repo + "/search-index-" + gitSha + ".bin"
}

func assetKeyForIndex(owner, repo, gitSha string) string {
	return AssetKeyForIndex(owner, repo, gitSha)
}
