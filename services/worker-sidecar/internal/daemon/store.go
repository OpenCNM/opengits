package daemon

import (
	"context"
	"log"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/ingest"
	"github.com/opengits/worker-sidecar/internal/jobs"
	"github.com/opengits/worker-sidecar/internal/market"
	mcpsidecar "github.com/opengits/worker-sidecar/internal/mcp"
	"github.com/opengits/worker-sidecar/internal/scheduler"
	"github.com/opengits/worker-sidecar/internal/search"
	"github.com/opengits/worker-sidecar/internal/sse"
	"github.com/opengits/worker-sidecar/internal/transcription"
	"github.com/opengits/worker-sidecar/internal/credits"
	"github.com/opengits/worker-sidecar/internal/update"
	"github.com/opengits/worker-sidecar/internal/userinteraction"
)

type pgxUpdateStore struct {
	*update.PgxStore
}

type pgxDocStore struct {
	*doc.PgxStore
}

type pgxTranscriptionStore struct {
	*transcription.PgxStore
}

type pgxIngestStore struct {
	*ingest.PgxStore
}

type pgxJobStore struct {
	*jobs.PgxStore
}

type pgxSchedulerStore struct {
	*scheduler.PgxStore
}

type pgxMarketStore struct {
	*market.PgxStore
}

type pgxUserInteractionStore struct {
	*userinteraction.PgxStore
}

type pgxCreditsStore struct {
	*credits.PgxStore
}

type pgxStore struct {
	pool      *pgxpool.Pool
	projStore *mcpsidecar.ProjectionStore
	sse.Store
	*search.PgxStore
	pgxUpdateStore
	pgxDocStore
	pgxTranscriptionStore
	pgxIngestStore
	pgxJobStore
	pgxSchedulerStore
	pgxMarketStore
	pgxUserInteractionStore
	pgxCreditsStore
}

func (s *pgxStore) SetProjectionStore(ps *mcpsidecar.ProjectionStore) {
	s.projStore = ps
	if s.pgxUpdateStore.PgxStore != nil {
		s.pgxUpdateStore.PgxStore.SetProjectionStore(ps)
	}
}

func (s *pgxStore) ProjectionStore() *mcpsidecar.ProjectionStore {
	return s.projStore
}

// dbExec pool 与事务共用的最小执行面。
type dbExec interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func (s *pgxStore) loadEffectiveNavTree(ctx context.Context, q dbExec, repoID, owner, repoName string, fallbackNavTreeJSON []byte) ([]*ingest.NavNode, error) {
	if s.pgxUpdateStore.PgxStore == nil {
		return nil, nil
	}
	return s.pgxUpdateStore.PgxStore.LoadEffectiveNavTree(ctx, q, repoID, owner, repoName, fallbackNavTreeJSON)
}

// EmergencyReadOnly 消除多嵌入领域存储之间的歧义，统一向 scout/jobs/scheduler 暴露只读状态。
func (s *pgxStore) EmergencyReadOnly(ctx context.Context) (bool, error) {
	if s.pgxSchedulerStore.PgxStore != nil {
		return s.pgxSchedulerStore.EmergencyReadOnly(ctx)
	}
	if s.pgxJobStore.PgxStore != nil {
		return s.pgxJobStore.EmergencyReadOnly(ctx)
	}
	if s.pgxTranscriptionStore.PgxStore != nil {
		return s.pgxTranscriptionStore.EmergencyReadOnly(ctx)
	}
	return false, nil
}

func (s *pgxStore) UpdateImportJobProgress(ctx context.Context, jobId string, step string, progress int) error {
	if s.pgxJobStore.PgxStore != nil {
		return s.pgxJobStore.UpdateImportJobProgress(ctx, jobId, step, progress)
	}
	if s.pgxIngestStore.PgxStore != nil {
		return s.pgxIngestStore.UpdateImportJobProgress(ctx, jobId, step, progress)
	}
	return nil
}

// 显式实现以消除 pgxUpdateStore, pgxSchedulerStore, pgxMarketStore 之间的选择器歧义
func (s *pgxStore) LeaseUpdateIfHeldOrExpired(ctx context.Context, key, owner string, until time.Time) (int64, error) {
	return s.pgxSchedulerStore.LeaseUpdateIfHeldOrExpired(ctx, key, owner, until)
}

func (s *pgxStore) UnlockDuePendingCredits(ctx context.Context) (*credits.VestingUnlockResult, error) {
	if s.pgxCreditsStore.PgxStore != nil {
		return s.pgxCreditsStore.PgxStore.UnlockDuePendingCredits(ctx)
	}
	return nil, nil
}

func (s *pgxStore) LeaseInsert(ctx context.Context, key, owner string, until time.Time) error {
	return s.pgxSchedulerStore.LeaseInsert(ctx, key, owner, until)
}

func (s *pgxStore) LeaseDelete(ctx context.Context, key, owner string) error {
	return s.pgxSchedulerStore.LeaseDelete(ctx, key, owner)
}

func (s *pgxStore) CleanExpiredLeases(ctx context.Context, expiredBefore time.Time) (int64, error) {
	return s.pgxSchedulerStore.CleanExpiredLeases(ctx, expiredBefore)
}

func (s *pgxStore) ReleaseExpiredClaims(ctx context.Context) (int64, error) {
	return s.pgxMarketStore.ReleaseExpiredClaims(ctx)
}

func (s *pgxStore) FailTrialsWithoutStaging(ctx context.Context) (int64, error) {
	return s.pgxMarketStore.FailTrialsWithoutStaging(ctx)
}

func (s *pgxStore) postSwapDocument(ctx context.Context, repoID, docID, content string) error {
	if strings.TrimSpace(content) == "" {
		return nil
	}
	d, err := s.LoadDocumentForPrepare(ctx, docID)
	if err != nil || d == nil {
		return err
	}
	req := chunker.MarkdownChunkRequest{
		Content:     content,
		DocPath:     d.Path,
		ParentTitle: doc.ExtractParentTitleFromNavTree(d.NavTree, d.Path),
	}
	chunks := chunker.ChunkMarkdown(req)
	if len(chunks) > 0 {
		if _, err := s.ReplaceDocumentChunks(ctx, docID, chunks, transcription.ReplaceChunksOpts{DocPath: d.Path}); err != nil {
			log.Printf("[market-settle] chunk rebuild degraded for %s: %v", docID, err)
		}
	}
	manifest := concept.ExtractConceptManifest(content, d.Path)
	if err := s.StoreDocumentMetadata(ctx, repoID, docID, d.Path, content, manifest, ""); err != nil {
		log.Printf("[market-settle] concept sync degraded for %s: %v", d.Path, err)
	}
	return nil
}

func (s *pgxStore) PostSwapDocument(ctx context.Context, repoID, docID, content string) error {
	return s.postSwapDocument(ctx, repoID, docID, content)
}

func (s *pgxStore) BatchEnqueueTranscription(ctx context.Context, repoId string, requestedBy string, options any) (int64, error) {
	return s.pgxTranscriptionStore.BatchEnqueueTranscription(ctx, repoId, requestedBy, options)
}

func newPgxStoreWithPool(pool *pgxpool.Pool) *pgxStore {
	ms := market.NewPgxStore(pool)
	s := &pgxStore{
		pool:                  pool,
		Store:                 sse.NewPgxStore(pool),
		PgxStore:              search.NewPgxStore(pool),
		pgxUpdateStore:        pgxUpdateStore{PgxStore: update.NewPgxStore(pool)},
		pgxDocStore:           pgxDocStore{PgxStore: doc.NewPgxStore(pool)},
		pgxTranscriptionStore: pgxTranscriptionStore{PgxStore: transcription.NewPgxStore(pool)},
		pgxIngestStore:        pgxIngestStore{PgxStore: ingest.NewPgxStore(pool)},
		pgxJobStore:           pgxJobStore{PgxStore: jobs.NewPgxStore(pool)},
		pgxSchedulerStore:       pgxSchedulerStore{PgxStore: scheduler.NewPgxStore(pool)},
		pgxMarketStore:          pgxMarketStore{PgxStore: ms},
		pgxUserInteractionStore: pgxUserInteractionStore{PgxStore: userinteraction.NewPgxStore(pool)},
		pgxCreditsStore:         pgxCreditsStore{PgxStore: credits.NewPgxStore(pool)},
	}
	ms.SetPostSwapHandler(s.postSwapDocument)
	return s
}

func newPgxStore(ctx context.Context, cfg Config) (*pgxStore, error) {
	poolCfg, err := pgxpool.ParseConfig(sanitizeDatabaseURL(cfg.DatabaseURL))
	if err != nil {
		return nil, err
	}
	poolCfg.MaxConns = int32(cfg.PoolMax)
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, err
	}
	return newPgxStoreWithPool(pool), nil
}

// sanitizeDatabaseURL 剥离 Prisma 专属查询参数。
func sanitizeDatabaseURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	q := u.Query()
	if cl := q.Get("connection_limit"); cl != "" && q.Get("pool_max_conns") == "" {
		q.Set("pool_max_conns", cl)
	}
	for _, key := range []string{"schema", "connection_limit", "pool_timeout"} {
		q.Del(key)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func isNoRows(err error) bool { return err == pgx.ErrNoRows }


