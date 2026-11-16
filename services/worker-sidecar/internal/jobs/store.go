package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/storeutil"
)

// JobEventEntry 导入进度事件条目。
type JobEventEntry struct {
	Seq     int            `json:"seq"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload,omitempty"`
}

// JobRow ImportJob 行最小读取面。
type JobRow struct {
	Id     string
	Owner  string
	Repo   string
	Branch string
	UserId *string
	Params []byte
	Status string
}

// CreateJobParams 创建导入任务入参。
type CreateJobParams struct {
	Owner   string  `json:"owner"`
	Repo    string  `json:"repo"`
	Branch  string  `json:"branch"`
	Edition string  `json:"edition,omitempty"`
	UserID  *string `json:"userId"`
	Params  any     `json:"params,omitempty"`
}

// CreateJobResult 任务创建/去重结果。
type CreateJobResult struct {
	ID      string `json:"id"`
	Deduped bool   `json:"deduped"`
}

// QueueStore 队列壳与执行体数据访问（接口化支撑单测 fake；PgxStore 真实实现）。
type QueueStore interface {
	ClaimNextQueuedJobs(ctx context.Context, slots int, guard []string) ([]string, error)
	GetImportJob(ctx context.Context, jobId string) (*JobRow, error)
	ReapStaleImportJobs(ctx context.Context, staleBefore time.Time) (int64, error)
	GcFinishedImportJobs(ctx context.Context, ttlBefore time.Time) (int64, error)
	FailImportJob(ctx context.Context, jobId, message string) (bool, error)
	HeartbeatImportJob(ctx context.Context, jobId string) error
	UpdateImportJobProgress(ctx context.Context, jobId string, step string, progress int) error
	InsertJobEvents(ctx context.Context, jobId string, events []JobEventEntry) error
	CreateImportJob(ctx context.Context, p CreateJobParams) (CreateJobResult, error)
	RequestImportPublication(ctx context.Context, repositoryId, userId string) error
	EmergencyReadOnly(ctx context.Context) (bool, error)
}

// PgxStore Postgres 持久化存储实现。
type PgxStore struct {
	pool         *pgxpool.Pool
	importReward ImportRewardAPI
}

// NewPgxStore 创建 jobs 专用 PgxStore。
func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{pool: pool}
}

// SetImportReward 注入 import-reward 回调客户端（nil 安全：nil 时 pending 堆积由下轮重试）。
func (s *PgxStore) SetImportReward(api ImportRewardAPI) {
	if s == nil {
		return
	}
	s.importReward = api
}

func (s *PgxStore) Pool() *pgxpool.Pool {
	if s == nil {
		return nil
	}
	return s.pool
}

const claimSQL = `
	UPDATE "ImportJob" AS j
	SET "status" = 'RUNNING',
	    "lastHeartbeatAt" = NOW(),
	    "startedAt" = COALESCE("startedAt", NOW()),
	    "updatedAt" = NOW()
	WHERE j."id" IN (
	  SELECT q."id"
	  FROM "ImportJob" q
	  WHERE q."status" = 'QUEUED'
	    AND (CARDINALITY($1::text[]) = 0 OR q."id"::text <> ALL($1))
	  ORDER BY q."createdAt" ASC
	  LIMIT $2
	  FOR UPDATE SKIP LOCKED
	)
	RETURNING j."id"`

const gcFinishedSQL = `
		DELETE FROM "ImportJob"
		WHERE "status" IN ('COMPLETED', 'FAILED') AND "finishedAt" < $1
		  AND COALESCE(result->>'importRewardPending', 'false') <> 'true'
		  AND NOT (
		    "status" = 'COMPLETED' AND NULLIF(result->>'repositoryId', '') IS NOT NULL
		    AND NOT EXISTS (
		      SELECT 1 FROM "CreditGrantLedger" l
		      WHERE l."repositoryId" = result->>'repositoryId' AND l.source = 'IMPORT_REWARD'
		    )
		  )`

// ─────────────────────────────────────────────────────────────
// ImportJob 队列壳（Phase 3 Slice B，逐字移植 import-job-store.ts 的认领/reap/GC）。
// 执行体（ingest 管线/事件写入/终态结算）在 Node 引擎子进程内完成——
// 本层只持有队列闸门主权：认领 → 派发 → 墙钟看护 → reap/GC 兜底。
// 状态全在 DB：kill -9 自愈链（心跳过期 reap + 孤儿 QUEUED 收养）对执行方无感。
// ─────────────────────────────────────────────────────────────

// claimSQL 与 import-job-store.ts claimNextQueuedJobs 的 $queryRaw 逐字对齐：
// 挑选与状态翻转在同一语句内完成，FOR UPDATE SKIP LOCKED 多消费者安全。

// ClaimNextQueuedJobs 原子认领缺口数个最旧的 QUEUED 任务。
// guard 为空数组时 `<> ALL(空集)` 恒真；::text 归一化 cuid 与参数类型。
func (s *PgxStore) ClaimNextQueuedJobs(ctx context.Context, slots int, guard []string) ([]string, error) {
	if slots <= 0 {
		return nil, nil
	}
	if guard == nil {
		guard = []string{}
	}
	return db.New(s.pool).ClaimNextQueuedJobs(ctx, db.ClaimNextQueuedJobsParams{
		Column1: guard,
		Limit:   int32(slots),
	})
}

// ReapStaleImportJobs 心跳过期的 RUNNING → FAILED；
// QUEUED 是闸门下的合法长寿命排队态，绝不判死（误杀排队任务是事故）。
func (s *PgxStore) ReapStaleImportJobs(ctx context.Context, staleBefore time.Time) (int64, error) {
	return db.New(s.pool).ReapStaleImportJobs(ctx, db.ReapStaleImportJobsParams{
		Error:           pgtype.Text{String: "导入任务中断：执行进程心跳过期（可能因服务重启），请重试导入", Valid: true},
		LastHeartbeatAt: pgtype.Timestamp{Time: staleBefore, Valid: true},
	})
}

// GcFinishedImportJobs 完工 Job 超 TTL 删除（ImportJobEvent 级联清理）。
// 回调 pending 与未兑现 IMPORT_REWARD 的成功导入凭据绝不 GC（显式发布是
// 数周后唯一兑现入口）；已发过奖（Repository 已有流水）的照常清理。

func (s *PgxStore) GcFinishedImportJobs(ctx context.Context, ttlBefore time.Time) (int64, error) {
	return db.New(s.pool).GcFinishedImportJobs(ctx, pgtype.Timestamp{Time: ttlBefore, Valid: true})
}

// FailImportJob 终态 CAS：仅 RUNNING 可落 FAILED（防僵尸任务回写覆盖）。
func (s *PgxStore) FailImportJob(ctx context.Context, jobId, message string) (bool, error) {
	affected, err := db.New(s.pool).FailImportJob(ctx, db.FailImportJobParams{
		Error: pgtype.Text{String: message, Valid: true},
		ID:    jobId,
	})
	return affected == 1, err
}

// GetImportJob 读取单个 ImportJob 行信息供 Go 编排体执行。
func (s *PgxStore) GetImportJob(ctx context.Context, jobId string) (*JobRow, error) {
	row, err := db.New(s.pool).GetImportJob(ctx, jobId)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var uid *string
	if row.UserId != "" {
		u := row.UserId
		uid = &u
	}
	return &JobRow{
		Id:     row.ID,
		Owner:  row.Owner,
		Repo:   row.Repo,
		Branch: row.Branch,
		UserId: uid,
		Params: row.Params,
		Status: row.Status,
	}, nil
}

// HeartbeatImportJob 刷新 ImportJob 租约心跳（lastHeartbeatAt）。
func (s *PgxStore) HeartbeatImportJob(ctx context.Context, jobId string) error {
	return db.New(s.pool).HeartbeatImportJob(ctx, jobId)
}

// InsertJobEvents 批量写入进度事件并刷新心跳。
// 使用 WithTx 事务保证原子写入，并同步刷新 lastHeartbeatAt；
// 事件体走 unnest 多行单语句（一批 50 条原为 50 次语句往返）。
func (s *PgxStore) InsertJobEvents(ctx context.Context, jobId string, events []JobEventEntry) error {
	if len(events) == 0 {
		return nil
	}
	return storeutil.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := db.New(tx)
		seqs := make([]int32, len(events))
		types := make([]string, len(events))
		payloads := make([][]byte, len(events))
		for i, e := range events {
			seqs[i] = int32(e.Seq)
			types[i] = e.Type
			if e.Payload != nil {
				if b, err := json.Marshal(e.Payload); err == nil {
					payloads[i] = b
				}
			}
		}
		if err := q.InsertJobEvents(ctx, db.InsertJobEventsParams{
			JobID:    jobId,
			Seqs:     seqs,
			Types:    types,
			Payloads: payloads,
		}); err != nil {
			return err
		}
		return q.HeartbeatImportJob(ctx, jobId)
	})
}

// EmergencyReadOnly 网关策略读取。
func (s *PgxStore) EmergencyReadOnly(ctx context.Context) (bool, error) {
	v, err := db.New(s.pool).GetEmergencyReadOnly(ctx)
	if isNoRows(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return v, nil
}

// ClaimPendingImportRewardJobs leases a bounded batch using the existing heartbeat.
// Failed callbacks rotate to the back of the queue; crashes become eligible next tick.
func (s *PgxStore) ClaimPendingImportRewardJobs(ctx context.Context, limit int, before time.Time) ([]string, error) {
	if limit <= 0 {
		return nil, nil
	}
	return db.New(s.pool).ClaimPendingImportRewardJobs(ctx, db.ClaimPendingImportRewardJobsParams{
		Limit:           int32(limit),
		LastHeartbeatAt: pgtype.Timestamp{Time: before, Valid: true},
	})
}

func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows) || err == pgx.ErrNoRows
}

type TxExec = storeutil.TxExec

// UpdateImportJobProgress 更新导入作业 options.progressInfo 动态流式进度（原子 SQL，零 schema 迁移）。
func UpdateImportJobProgress(ctx context.Context, dbx TxExec, jobId string, step string, progress int) error {
	payload, err := storeutil.FormatProgressPayload(step, progress)
	if err != nil {
		return err
	}
	return db.New(dbx).UpdateImportJobProgress(ctx, db.UpdateImportJobProgressParams{
		Column1: payload,
		ID:      jobId,
	})
}

func (s *PgxStore) UpdateImportJobProgress(ctx context.Context, jobId string, step string, progress int) error {
	if s.pool == nil {
		return errors.New("store pool is nil")
	}
	return UpdateImportJobProgress(ctx, s.pool, jobId, step, progress)
}

// CreateImportJob 任务入队（第一性原理单写者收敛：轻量咨询锁防重 + 活跃任务复用 + 原子创建）。
func (s *PgxStore) CreateImportJob(ctx context.Context, p CreateJobParams) (CreateJobResult, error) {
	if s.pool == nil {
		return CreateJobResult{}, errors.New("store pool is nil")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CreateJobResult{}, fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	uid := ""
	if p.UserID != nil {
		uid = *p.UserID
	}

	q := db.New(tx)

	// 1. 若为指定用户，获取该用户同仓活跃任务的事务级咨询锁（轻量互斥，不锁 User 表，防同用户同仓瞬时并发重入）
	if uid != "" {
		lockKey := fmt.Sprintf("import_job:%s:%s/%s@%s:%s", uid, p.Owner, p.Repo, p.Branch, p.Edition)
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", lockKey); err != nil {
			return CreateJobResult{}, fmt.Errorf("acquire advisory lock: %w", err)
		}

		// 2. 检查是否有同用户同仓活跃任务（QUEUED 或 RUNNING）
		existingID, err := q.FindActiveImportJob(ctx, db.FindActiveImportJobParams{
			Owner:   p.Owner,
			Repo:    p.Repo,
			Branch:  p.Branch,
			Column4: p.Edition,
			UserId:  uid,
		})
		if err == nil && existingID != "" {
			_ = tx.Commit(ctx)
			return CreateJobResult{ID: existingID, Deduped: true}, nil
		} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return CreateJobResult{}, fmt.Errorf("check active job: %w", err)
		}
	}

	// 3. 不存在活跃任务，执行插入
	var paramsJSON []byte
	if p.Params != nil {
		if b, err := json.Marshal(p.Params); err == nil && string(b) != "null" {
			paramsJSON = b
		}
	}

	newID, err := q.CreateImportJob(ctx, db.CreateImportJobParams{
		Owner:   p.Owner,
		Repo:    p.Repo,
		Branch:  p.Branch,
		Column4: p.Edition,
		UserId:  uid,
		Column6: paramsJSON,
	})
	if err != nil {
		return CreateJobResult{}, fmt.Errorf("insert import job: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return CreateJobResult{}, fmt.Errorf("commit import job: %w", err)
	}
	return CreateJobResult{ID: newID, Deduped: false}, nil
}

// RequestImportPublication 请求发布导入（对齐 TS import-reward:74）。
func (s *PgxStore) RequestImportPublication(ctx context.Context, repositoryId, userId string) error {
	return db.New(s.pool).RequestImportPublication(ctx, db.RequestImportPublicationParams{
		UserId:  userId,
		Column2: repositoryId,
	})
}
