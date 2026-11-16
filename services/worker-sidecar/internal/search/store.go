package search

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Store 检索层数据访问接口。
type Store interface {
	SearchRepositoryChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error)
	SearchGlobalChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error)
	SearchUnified(ctx context.Context, req UnifiedSearchRequest) ([]UnifiedSearchHit, error)
}

// SearchStore 兼容别名。
type SearchStore = Store

// PgxStore 基于 pgxpool.Pool 的 Postgres 检索与索引存储实现。
type PgxStore struct {
	pool *pgxpool.Pool
}

// NewPgxStore 构建检索存储实例。
func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{pool: pool}
}

// Pool 获取内部数据库连接池。
func (s *PgxStore) Pool() *pgxpool.Pool {
	if s == nil {
		return nil
	}
	return s.pool
}

// SearchChunks 进程内统一检索直通入口（实现 mcpsidecar.SearchEngine 接口，零 IPC 反调）。
func (s *PgxStore) SearchChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error) {
	if strings.TrimSpace(req.Query) == "" && strings.TrimSpace(req.RawQuery) == "" {
		return []SearchChunkHit{}, nil
	}
	if req.IsGlobal || req.RepositoryID == "" {
		return s.SearchGlobalChunks(ctx, req)
	}
	return s.SearchRepositoryChunks(ctx, req)
}
