package transcription

import (
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// PgxStore 转录子系统 PostgreSQL 数据访问实现。
type PgxStore struct {
	pool    *pgxpool.Pool
	queries *db.Queries

	// 教学序路径短 TTL 缓存：附页/内联全景章的图谱后处理对同仓逐文档
	// 调 SyncDocumentCurriculumEdge，每次重读大纲+navTree——批内合并为
	// 一次读。窗口 5s，大纲本就在批后才落库，教学序边在下次文档同步自愈。
	teachingOrderMu    sync.Mutex
	teachingOrderCache map[string]teachingOrderEntry
}

type teachingOrderEntry struct {
	paths    []string
	loadedAt time.Time
}

// teachingOrderCacheTTL 教学序路径缓存窗口。
const teachingOrderCacheTTL = 5 * time.Second

// NewPgxStore 创建转录 PgxStore 实例。
func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{
		pool:               pool,
		queries:            db.New(pool),
		teachingOrderCache: make(map[string]teachingOrderEntry),
	}
}
