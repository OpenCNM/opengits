package transcription

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// ─────────────────────────────────────────────────────────────
// TranscriptionJob 队列（Go 单写者）：认领/reap/崩溃兜底/终态/通知全链闭环
// 于本包与 runner（Node 侧消费循环已退役，仅保留入队与断点存档生产者）。
// 断点续接语义：chunk 存档在 TranscriptionJob 行上，执行体崩溃回 QUEUED 后
// 从存档点续跑。
// ─────────────────────────────────────────────────────────────

// EnqueueJobParams defines input parameters for enqueueing a transcription job.
type EnqueueJobParams struct {
	DocumentID  string
	RequestedBy string
	Priority    int
	Options     any
}

// SaveCheckpointParams defines parameters for saving a transcription chunk checkpoint.
type SaveCheckpointParams struct {
	DocumentID  string
	RequestedBy string
	Fingerprint string
	Index       int
	Total       int
	Content     string
}

// QueueStore 转录队列数据访问。
type QueueStore interface {
	ClaimNextTranscriptionJobs(ctx context.Context, limit int) ([]TranscriptionClaim, error)
	ReapStaleTranscriptionJobs(ctx context.Context, staleBefore time.Time) (int64, error)
	DeferTranscriptionJob(ctx context.Context, jobId string) (bool, error)
	FailTranscriptionJobExhausted(ctx context.Context, jobId, message string) (bool, error)
	CompleteTranscriptionJob(ctx context.Context, jobId string) error
	EnqueueTranscriptionJob(ctx context.Context, p EnqueueJobParams) (string, error)
	EmergencyReadOnly(ctx context.Context) (bool, error)
	BatchEnqueueTranscription(ctx context.Context, repoId, requestedBy string, options any) (int64, error)
	PrioritizeTranscriptionJob(ctx context.Context, documentId, requestedBy string, priority int) error
}

// CompleteTranscriptionJob 成功终态落库（D组6a：Go body 路径此前从不写
// DONE——任务滞留 RUNNING 被孤儿回收无限重扫；DONE + finishedAt + lastError
// 清空 + chunk 存档清位（零物化））。CAS status='RUNNING'（2026-09-19 状态机
// 守卫补齐，states.go）：reap 回队→二次认领后，旧 worker 迟到的 DONE 不得
// 覆盖新执行态——BUG-42 同族竞态的转录侧收口。
func (s *PgxStore) CompleteTranscriptionJob(ctx context.Context, jobId string) error {
	/*
		_, err := s.pool.Exec(ctx, `
			UPDATE "TranscriptionJob"
			SET "status" = 'DONE', "finishedAt" = now(), "lastError" = NULL,
			    "checkpointChunks" = NULL, "checkpointTotal" = NULL, "updatedAt" = now()
			WHERE "id" = $1 AND "status" = 'RUNNING'`, jobId)
	*/
	return s.queries.TranscriptionCompleteJob(ctx, jobId)
}

// TranscriptionClaim 认领结果（对齐 Node claim RETURNING 列）。
type TranscriptionClaim struct {
	ID          string
	DocumentID  string
	RequestedBy string
	// Options 触发时的处理选项(JSON:enhance/model/targetLanguage/...),
	// 空串=无选项(缺省语义)
	Options string
}

func (s *PgxStore) ClaimNextTranscriptionJobs(ctx context.Context, limit int) ([]TranscriptionClaim, error) {
	if limit <= 0 {
		return nil, nil
	}
	rows, err := s.queries.TranscriptionClaimNextJobs(ctx, int32(limit))
	if err != nil {
		return nil, err
	}
	var out []TranscriptionClaim
	for _, r := range rows {
		out = append(out, TranscriptionClaim{
			ID:          r.ID,
			DocumentID:  r.DocumentId,
			RequestedBy: r.RequestedBy,
			Options:     string(r.Options),
		})
	}
	return out, nil
}

// ReapStaleTranscriptionJobs RUNNING 孤儿（真活跃心跳超期）收割——
// 采用 Dead Man's Switch 机制：以 COALESCE("updatedAt", "claimedAt") < $1 为准，
// 避免误杀正在持续流式生成长文本/思考模型的健康任务。
// 毒丸防御（Poison Pill Defense）：
// - 递增 attempts = attempts + 1
// - 若 attempts + 1 < 3：置回 QUEUED，claimedAt = NULL，保留 checkpoint 供断点续跑；
// - 若 attempts + 1 >= 3：置为 FAILED，级联更新关联 Document.status = 'ERROR'，终结无限崩溃循环。
func (s *PgxStore) ReapStaleTranscriptionJobs(ctx context.Context, staleBefore time.Time) (int64, error) {
	var totalReaped int64
	/*
		var totalReaped int64
		err := s.pool.QueryRow(ctx, `
			WITH stale_jobs AS (
				SELECT id, "documentId", attempts
				FROM "TranscriptionJob"
				WHERE "status" = 'RUNNING'
				  AND COALESCE("updatedAt", "claimedAt") < $1
			),
			requeued_jobs AS (
				UPDATE "TranscriptionJob" j
				SET "status" = 'QUEUED',
				    attempts = j.attempts + 1,
				    "claimedAt" = NULL,
				    "updatedAt" = now()
				FROM stale_jobs s
				WHERE j.id = s.id
				  AND j."status" = 'RUNNING'
				  AND s.attempts + 1 < 3
				RETURNING j.id
			),
			failed_jobs AS (
				UPDATE "TranscriptionJob" j
				SET "status" = 'FAILED',
				    attempts = j.attempts + 1,
				    "lastError" = 'Stale execution lease expired (exceeded 3 retry attempts)',
				    "finishedAt" = now(),
				    "updatedAt" = now()
				FROM stale_jobs s
				WHERE j.id = s.id
				  AND j."status" = 'RUNNING'
				  AND s.attempts + 1 >= 3
				RETURNING j.id, j."documentId"
			),
			failed_docs AS (
				UPDATE "Document" d
				SET status = 'ERROR',
				    "errorMessage" = 'Transcription job timed out after 3 retry attempts',
				    "updatedAt" = now()
				FROM failed_jobs f
				WHERE d.id = f."documentId"
				  AND d.status != 'PROCESSED'
				RETURNING d.id
			)
			SELECT (SELECT count(*) FROM requeued_jobs) + (SELECT count(*) FROM failed_jobs)`, staleBefore).Scan(&totalReaped)
		if err != nil {
			return 0, err
		}
	*/
	totalReaped, err := s.queries.TranscriptionReapStaleJobs(ctx, pgtype.Timestamp{Time: staleBefore, Valid: true})
	if err != nil {
		return 0, err
	}
	return totalReaped, nil
}

// DeferTranscriptionJob 子进程异常退出时的兜底：回 QUEUED（断点续接，不计 attempts）。
// 正常路径的预算延迟（deferred）由子进程自身落库，本方法仅覆盖崩溃场景。
func (s *PgxStore) DeferTranscriptionJob(ctx context.Context, jobId string) (bool, error) {
	/*
		tag, err := s.pool.Exec(ctx, `
			UPDATE "TranscriptionJob"
			SET "status" = 'QUEUED', "claimedAt" = NULL, "updatedAt" = now()
			WHERE "id" = $1 AND "status" = 'RUNNING'`, jobId)
		if err != nil {
			return false, err
		}
	*/
	rowsAffected, err := s.queries.TranscriptionDeferJob(ctx, jobId)
	if err != nil {
		return false, err
	}
	return rowsAffected == 1, nil
}

// FailTranscriptionJobExhausted 崩溃兜底的保守路径：attempts 达上限置 FAILED
// （对齐 failTranscriptionJob 的 attempts+1>=3 分支；Go 侧只在子进程反复崩溃时到达此处）。
func (s *PgxStore) FailTranscriptionJobExhausted(ctx context.Context, jobId, message string) (bool, error) {
	/*
		tag, err := s.pool.Exec(ctx, `
			UPDATE "TranscriptionJob"
			SET "status" = 'FAILED', attempts = attempts + 1,
			    "lastError" = left($1, 500), "finishedAt" = now(), "updatedAt" = now()
			WHERE "id" = $2 AND "status" = 'RUNNING'
			  AND attempts + 1 >= 3`, message, jobId)
		if err != nil {
			return false, err
		}
		if tag.RowsAffected() == 1 {
			// 级联将关联 Document 置为 ERROR，解除读者端/作者端 PROCESSING 假死
			_, _ = s.pool.Exec(ctx, `
				UPDATE "Document"
				SET status = 'ERROR', "errorMessage" = left($1, 500), "updatedAt" = now()
				WHERE id = (SELECT "documentId" FROM "TranscriptionJob" WHERE id = $2)
				  AND status = 'PROCESSING'`, message, jobId)
			return true, nil
		}
		// 未达上限：回 QUEUED 重试（与 failTranscriptionJob 非 exhaust 分支同语义）
		tag2, err := s.pool.Exec(ctx, `
			UPDATE "TranscriptionJob"
			SET "status" = 'QUEUED', attempts = attempts + 1,
			    "lastError" = left($1, 500), "updatedAt" = now()
			WHERE "id" = $2 AND "status" = 'RUNNING'`, message, jobId)
		if err != nil {
			return false, err
		}
	*/
	rowsAffected, err := s.queries.TranscriptionFailJobExhausted(ctx, db.TranscriptionFailJobExhaustedParams{
		Message: message,
		ID:      jobId,
	})
	if err != nil {
		return false, err
	}
	if rowsAffected == 1 {
		_ = s.queries.TranscriptionSetDocErrorExhausted(ctx, db.TranscriptionSetDocErrorExhaustedParams{
			Message: message,
			ID:      jobId,
		})
		// 报忧通知（单写者收敛：Node 消费循环退役后由 Go 终态分支触发；
		// SQL 内含 10 分钟防抖窗口，插入失败静默——通知不阻断终态）
		_, _ = s.queries.InsertTutorialTranscriptionFailedNotification(ctx, db.InsertTutorialTranscriptionFailedNotificationParams{
			Message: message,
			JobID:   jobId,
		})
		return true, nil
	}
	rowsAffected2, err := s.queries.TranscriptionFailJobRequeue(ctx, db.TranscriptionFailJobRequeueParams{
		Message: message,
		ID:      jobId,
	})
	if err != nil {
		return false, err
	}
	return rowsAffected2 == 1, nil
}

// EmergencyReadOnly 紧急只读熔断检查。
func (s *PgxStore) EmergencyReadOnly(ctx context.Context) (bool, error) {
	v, err := s.queries.TranscriptionEmergencyReadOnly(ctx)
	if err != nil {
		return false, nil // fail-open
	}
	return v, nil
}

// EnqueueTranscriptionJob 章节转录任务入队（对齐 TS enqueueTranscription）。
func (s *PgxStore) EnqueueTranscriptionJob(ctx context.Context, p EnqueueJobParams) (string, error) {
	var optsJSON []byte
	if p.Options != nil {
		if b, err := json.Marshal(p.Options); err == nil && string(b) != "{}" && string(b) != "null" {
			optsJSON = b
		}
	}

	row, err := s.queries.TranscriptionGetJobStatus(ctx, p.DocumentID)
	if err == nil {
		existingID := row.ID
		existingStatus := row.Status
		if existingStatus == string(TStatusDone) || existingStatus == string(TStatusFailed) {
			fromStatus := TStatusDone
			if existingStatus == string(TStatusFailed) {
				fromStatus = TStatusFailed
			}
			uerr := s.queries.TranscriptionResetJob(ctx, db.TranscriptionResetJobParams{
				Priority:   int32(p.Priority),
				Options:    optsJSON,
				ID:         existingID,
				FromStatus: string(fromStatus),
			})
			return "reset", uerr
		}
		return "exists", nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}

	cerr := s.queries.TranscriptionInsertJob(ctx, db.TranscriptionInsertJobParams{
		DocumentID:  p.DocumentID,
		RequestedBy: p.RequestedBy,
		Priority:    int32(p.Priority),
		Options:     optsJSON,
	})
	return "queued", cerr
}

// BatchEnqueueTranscription 批量将某仓库下所有 UNPROCESSED 文档入队（以拓扑优先级递减）
func (s *PgxStore) BatchEnqueueTranscription(ctx context.Context, repoId, requestedBy string, options any) (int64, error) {
	optsJSON, err := json.Marshal(options)
	if err != nil || len(optsJSON) == 0 {
		optsJSON = []byte("{}")
	}
	if requestedBy == "" {
		requestedBy = "system"
	}
	return s.queries.TranscriptionBatchEnqueueJobs(ctx, db.TranscriptionBatchEnqueueJobsParams{
		RepositoryID: repoId,
		RequestedBy:  requestedBy,
		Options:      optsJSON,
	})
}

// PrioritizeTranscriptionJob 提权或插入高优先级转录任务（插队即时抢占）
func (s *PgxStore) PrioritizeTranscriptionJob(ctx context.Context, documentId, requestedBy string, priority int) error {
	if priority <= 0 {
		priority = 1000000
	}
	if requestedBy == "" {
		requestedBy = "system"
	}
	_, err := s.queries.TranscriptionPrioritizeJob(ctx, db.TranscriptionPrioritizeJobParams{
		DocumentID:  documentId,
		RequestedBy: requestedBy,
		Priority:    int32(priority),
	})
	return err
}
