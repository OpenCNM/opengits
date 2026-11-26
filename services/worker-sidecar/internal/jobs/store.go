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

type JobEventEntry struct {
	Seq     int            `json:"seq"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload,omitempty"`
}

type JobRow struct {
	Id     string
	Owner  string
	Repo   string
	Branch string
	UserId *string
	Params []byte
	Status string
}

type CreateJobParams struct {
	Owner   string  `json:"owner"`
	Repo    string  `json:"repo"`
	Branch  string  `json:"branch"`
	Edition string  `json:"edition,omitempty"`
	UserID  *string `json:"userId"`
	Params  any     `json:"params,omitempty"`
}

type CreateJobResult struct {
	ID      string `json:"id"`
	Deduped bool   `json:"deduped"`
}

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

type PgxStore struct {
	pool         *pgxpool.Pool
	importReward ImportRewardAPI
}

func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{pool: pool}
}

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

// Only reap RUNNING jobs with expired heartbeats; QUEUED jobs wait indefinitely behind the gate.
func (s *PgxStore) ReapStaleImportJobs(ctx context.Context, staleBefore time.Time) (int64, error) {
	return db.New(s.pool).ReapStaleImportJobs(ctx, db.ReapStaleImportJobsParams{
		Error:           pgtype.Text{String: "导入任务中断：执行进程心跳过期（可能因服务重启），请重试导入", Valid: true},
		LastHeartbeatAt: pgtype.Timestamp{Time: staleBefore, Valid: true},
	})
}

// Retain completed jobs awaiting reward callback or unredeemed IMPORT_REWARD beyond TTL GC.
func (s *PgxStore) GcFinishedImportJobs(ctx context.Context, ttlBefore time.Time) (int64, error) {
	return db.New(s.pool).GcFinishedImportJobs(ctx, pgtype.Timestamp{Time: ttlBefore, Valid: true})
}

// Guard FailImportJob with status = 'RUNNING' CAS so stale workers cannot overwrite COMPLETED.
func (s *PgxStore) FailImportJob(ctx context.Context, jobId, message string) (bool, error) {
	affected, err := db.New(s.pool).FailImportJob(ctx, db.FailImportJobParams{
		Error: pgtype.Text{String: message, Valid: true},
		ID:    jobId,
	})
	return affected == 1, err
}

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

func (s *PgxStore) HeartbeatImportJob(ctx context.Context, jobId string) error {
	return db.New(s.pool).HeartbeatImportJob(ctx, jobId)
}

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

	// Acquire per-(user, repo) advisory xact lock to deduplicate concurrent CreateImportJob calls.
	if uid != "" {
		lockKey := fmt.Sprintf("import_job:%s:%s/%s@%s:%s", uid, p.Owner, p.Repo, p.Branch, p.Edition)
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", lockKey); err != nil {
			return CreateJobResult{}, fmt.Errorf("acquire advisory lock: %w", err)
		}

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

func (s *PgxStore) RequestImportPublication(ctx context.Context, repositoryId, userId string) error {
	return db.New(s.pool).RequestImportPublication(ctx, db.RequestImportPublicationParams{
		UserId:  userId,
		Column2: repositoryId,
	})
}
