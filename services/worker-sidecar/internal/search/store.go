package search

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Store interface {
	SearchRepositoryChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error)
	SearchGlobalChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error)
	SearchUnified(ctx context.Context, req UnifiedSearchRequest) ([]UnifiedSearchHit, error)
}

type SearchStore = Store

type PgxStore struct {
	pool *pgxpool.Pool
}

func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{pool: pool}
}

func (s *PgxStore) Pool() *pgxpool.Pool {
	if s == nil {
		return nil
	}
	return s.pool
}

func (s *PgxStore) SearchChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error) {
	if strings.TrimSpace(req.Query) == "" && strings.TrimSpace(req.RawQuery) == "" {
		return []SearchChunkHit{}, nil
	}
	if len(req.RepositoryIDs) > 0 {
		return s.SearchScopedChunks(ctx, req)
	}
	if req.IsGlobal || req.RepositoryID == "" {
		return s.SearchGlobalChunks(ctx, req)
	}
	return s.SearchRepositoryChunks(ctx, req)
}
