package transcription

import (
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

type PgxStore struct {
	pool    *pgxpool.Pool
	queries *db.Queries

	// 5s TTL coalesces repeated curriculum-order outline reads across concurrent chapter post-processing.
	teachingOrderMu    sync.Mutex
	teachingOrderCache map[string]teachingOrderEntry
}

type teachingOrderEntry struct {
	paths    []string
	loadedAt time.Time
}

const teachingOrderCacheTTL = 5 * time.Second

func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{
		pool:               pool,
		queries:            db.New(pool),
		teachingOrderCache: make(map[string]teachingOrderEntry),
	}
}
