package market

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// ── Phase 10: 更新市场状态机单写者数据访问实现 ──────────────────────

var (
	ErrJobNotFound       = errors.New("job not found")
	ErrDocNotFound       = errors.New("document not found")
	ErrJobInvalidState   = errors.New("invalid job state")
	ErrJobAlreadyClaimed = errors.New("job already claimed")
)

// ListActiveJobs 查询活跃任务（PENDING, CLAIMED, TRIAL）关联文档标题。
func (s *PgxStore) ListActiveJobs(ctx context.Context, repoID string) ([]ActiveJobView, error) {
	rows, err := s.queries.MarketListActiveJobs(ctx, repoID)
	if err != nil {
		return nil, err
	}
	var out []ActiveJobView
	for _, v := range rows {
		var claimedBy *string
		if v.ClaimedBy.Valid {
			claimedBy = &v.ClaimedBy.String
		}
		var voteDeadline *time.Time
		if v.VoteDeadline.Valid {
			voteDeadline = &v.VoteDeadline.Time
		}
		var doc *ActiveJobDoc
		if v.Title.Valid {
			doc = &ActiveJobDoc{Title: v.Title.String}
		}
		out = append(out, ActiveJobView{
			ID:            v.ID,
			DocumentID:    v.DocumentId,
			Path:          v.Path,
			Status:        v.Status,
			Kind:          v.Kind,
			FromSha:       v.FromSha,
			ToSha:         v.ToSha,
			ClaimedBy:     claimedBy,
			VoteDeadline:  voteDeadline,
			FrozenCredits: int(v.FrozenCredits),
			Document:      doc,
		})
	}
	return out, nil
}

// GetJobAuthInfo 查询任务或对应文档所属仓库鉴权元数据。
func (s *PgxStore) GetJobAuthInfo(ctx context.Context, id string) (*JobAuthInfo, error) {
	row, err := s.queries.MarketGetJobAuthInfo(ctx, id)
	if err == nil {
		return &JobAuthInfo{
			ID:           row.ID,
			RepositoryID: row.RepositoryId,
			Kind:         row.Kind,
			Status:       row.Status,
			IsPublic:     row.IsPublic,
		}, nil
	}
	if err != pgx.ErrNoRows {
		return nil, err
	}

	// 尝试作为 documentId 查询
	docRow, err := s.queries.MarketGetJobAuthInfoDocFallback(ctx, id)
	if err == nil {
		return &JobAuthInfo{
			ID:           docRow.ID,
			RepositoryID: docRow.RepositoryId,
			Kind:         docRow.Kind,
			Status:       docRow.Status,
			IsPublic:     docRow.IsPublic,
		}, nil
	}
	if err == pgx.ErrNoRows {
		return nil, ErrJobNotFound
	}
	return nil, err
}

// ClaimJob CAS 认领任务：PENDING 且无有效租约 → CLAIMED。
func (s *PgxStore) ClaimJob(ctx context.Context, jobID, userID string, ttlMinutes int) (*ClaimResult, error) {
	if ttlMinutes <= 0 {
		ttlMinutes = 120
	}
	affected, err := s.queries.MarketClaimJob(ctx, db.MarketClaimJobParams{
		ClaimedBy:  pgtype.Text{String: userID, Valid: true},
		TtlMinutes: fmt.Sprintf("%d", ttlMinutes),
		ID:         jobID,
	})
	if err != nil {
		return nil, err
	}
	if affected == 0 {
		status, err := s.queries.MarketGetJobStatus(ctx, jobID)
		if err != nil {
			if err == pgx.ErrNoRows {
				return nil, ErrJobNotFound
			}
			return nil, err
		}
		if status != "PENDING" {
			return nil, ErrJobInvalidState
		}
		return nil, ErrJobAlreadyClaimed
	}
	return &ClaimResult{FrozenCredits: 0}, nil
}

// ReleaseClaim CAS 放弃认领：仅本人认领的 CLAIMED → PENDING。
func (s *PgxStore) ReleaseClaim(ctx context.Context, jobID, userID string) error {
	affected, err := s.queries.MarketReleaseClaim(ctx, db.MarketReleaseClaimParams{
		ID:        jobID,
		ClaimedBy: pgtype.Text{String: userID, Valid: true},
	})
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrJobInvalidState
	}
	return nil
}

// ExtendClaim CAS 续期认领租约：仅本人持有且未过期的 CLAIMED 租约可续
// （过期租约已被回池，不可复活——失败封闭）。返回是否续期成功。
func (s *PgxStore) ExtendClaim(ctx context.Context, jobID, userID string, ttlMinutes int) (bool, error) {
	if ttlMinutes <= 0 {
		ttlMinutes = 120
	}
	affected, err := s.queries.MarketExtendClaim(ctx, db.MarketExtendClaimParams{
		TtlMinutes: fmt.Sprintf("%d", ttlMinutes),
		ID:         jobID,
		ClaimedBy:  pgtype.Text{String: userID, Valid: true},
	})
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}

// SettleRelayTx RELAY 桩直换：CLAIMED → SWAPPED + 换入文档 + 创建版本。
// 晋升正文事务内按 stagedContentId 从内容寻址层读取（调用方不再全文直传，
// 与 TRIAL 排水 swapInJob 同源）；读取失败/为空整体回滚（失败封闭——绝不
// 悬垂 contentId + NULL content 半价晋升）。
func (s *PgxStore) SettleRelayTx(ctx context.Context, input RelaySettleInput) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		qtx := s.queries.WithTx(tx)
		if err := qtx.MarketAdvisoryLock(ctx, "canonical-doc:"+input.DocumentID); err != nil {
			return err
		}

		affected, err := qtx.MarketSettleRelayTxUpdateJob(ctx, db.MarketSettleRelayTxUpdateJobParams{
			StagedContentId: pgtype.Text{String: input.StagedContentID, Valid: true},
			StagedModel:     pgtype.Text{String: input.StagedModel, Valid: input.StagedModel != ""},
			ID:              input.JobID,
			ClaimedBy:       pgtype.Text{String: input.UserID, Valid: true},
		})
		if err != nil {
			return err
		}
		if affected == 0 {
			return ErrJobInvalidState
		}

		content, err := qtx.MarketLoadStagedContent(ctx, input.StagedContentID)
		if err != nil {
			return err
		}
		if !content.Valid || strings.TrimSpace(content.String) == "" {
			return ErrJobInvalidState
		}

		if err := qtx.MarketSettleRelayTxUpdateVersion(ctx, input.DocumentID); err != nil {
			return err
		}

		if err := qtx.MarketSettleSwapTxDoc(ctx, db.MarketSettleSwapTxDocParams{
			ContentId:       pgtype.Text{String: input.StagedContentID, Valid: true},
			Content:         content.String,
			DualWrite:       input.DualWrite,
			GitSha:          pgtype.Text{String: input.ToSha, Valid: true},
			GenerationModel: input.StagedModel,
			ID:              input.DocumentID,
		}); err != nil {
			return err
		}

		if err := qtx.MarketSettleRelayTxInsertVersion(ctx, db.MarketSettleRelayTxInsertVersionParams{
			DocumentId:   input.DocumentID,
			RepositoryId: input.RepositoryID,
			AuthorId:     input.UserID,
			ContentId:    input.StagedContentID,
		}); err != nil {
			return err
		}

		return nil
	})
}

// MarkJobFailed CAS 标记失败：仅本人认领的 CLAIMED → FAILED。
func (s *PgxStore) MarkJobFailed(ctx context.Context, jobID, userID, errMsg string) error {
	msg := truncate(errMsg, 500)
	affected, err := s.queries.MarketMarkJobFailed(ctx, db.MarketMarkJobFailedParams{
		ErrorMessage: pgtype.Text{String: msg, Valid: true},
		ID:           jobID,
		ClaimedBy:    pgtype.Text{String: userID, Valid: true},
	})
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrJobInvalidState
	}
	return nil
}


// EnsureRelayJob 按需为未烘焙章节探测或建立 RELAY 任务。
func (s *PgxStore) EnsureRelayJob(ctx context.Context, documentID string) (*RelayJobView, error) {
	var result RelayJobView
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		qtx := s.queries.WithTx(tx)
		if err := qtx.MarketAdvisoryLock(ctx, documentID); err != nil {
			return err
		}

		docRow, err := qtx.MarketEnsureRelayJobGetDoc(ctx, documentID)
		if err != nil {
			if err == pgx.ErrNoRows {
				return ErrDocNotFound
			}
			return err
		}

		sha := ""
		if docRow.GitSha.Valid {
			sha = docRow.GitSha.String
		}

		jobRow, err := qtx.MarketEnsureRelayJobGetJob(ctx, documentID)
		if err == nil {
			if jobRow.Status == "CLAIMED" && jobRow.ClaimedUntil.Valid && jobRow.ClaimedUntil.Time.Before(time.Now()) {
				_ = qtx.MarketEnsureRelayJobUpdateJob(ctx, jobRow.ID)
				result = RelayJobView{
					ID:           jobRow.ID,
					RepositoryID: jobRow.RepositoryId,
					Kind:         jobRow.Kind,
					Status:       "PENDING",
				}
				return nil
			}
			result = RelayJobView{
				ID:           jobRow.ID,
				RepositoryID: jobRow.RepositoryId,
				Kind:         jobRow.Kind,
				Status:       jobRow.Status,
			}
			return nil
		} else if err != pgx.ErrNoRows {
			return err
		}

		newJob, err := qtx.MarketEnsureRelayJobInsertJob(ctx, db.MarketEnsureRelayJobInsertJobParams{
			RepositoryId: docRow.RepositoryId,
			DocumentId:   docRow.ID,
			Path:         docRow.Path,
			FromSha:      sha,
			ToSha:        sha,
		})
		if err != nil {
			return err
		}
		result.ID = newJob.ID
		result.RepositoryID = newJob.RepositoryId
		result.Kind = newJob.Kind
		result.Status = newJob.Status
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// CreateRetranslateJob 重译留痕任务直接生成 SWAPPED 记录。
func (s *PgxStore) CreateRetranslateJob(ctx context.Context, input RetranslateJobInput) error {
	return s.queries.MarketCreateRetranslateJob(ctx, db.MarketCreateRetranslateJobParams{
		RepositoryId:    input.RepositoryID,
		DocumentId:      input.DocumentID,
		Path:            input.Path,
		FromSha:         input.GitSha,
		ClaimedBy:       pgtype.Text{String: input.UserID, Valid: true},
		StagedContentId: pgtype.Text{String: input.StagedContentID, Valid: true},
		StagedModel:     pgtype.Text{String: input.StagedModel, Valid: input.StagedModel != ""},
	})
}

// CreateStaleJobs 调度器批量建单（过期章节标记 PENDING）。
func (s *PgxStore) CreateStaleJobs(ctx context.Context, input CreateStaleJobsInput) (int, error) {
	if len(input.Paths) == 0 {
		return 0, nil
	}
	var createdCount int
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		qtx := s.queries.WithTx(tx)
		docs, err := qtx.MarketCreateStaleJobsGetDocs(ctx, db.MarketCreateStaleJobsGetDocsParams{
			RepositoryId: input.RepositoryID,
			Paths:        input.Paths,
		})
		if err != nil {
			return err
		}
		if len(docs) == 0 {
			return nil
		}

		busyRows, err := qtx.MarketCreateStaleJobsGetBusy(ctx, input.RepositoryID)
		if err != nil {
			return err
		}

		busy := map[string]bool{}
		for _, docID := range busyRows {
			busy[docID] = true
		}

		for _, doc := range docs {
			if busy[doc.ID] {
				continue
			}
			err := qtx.MarketCreateStaleJobsInsertJob(ctx, db.MarketCreateStaleJobsInsertJobParams{
				RepositoryId: input.RepositoryID,
				DocumentId:   doc.ID,
				Path:         doc.Path,
				FromSha:      input.FromSha,
				ToSha:        input.ToSha,
			})
			if err != nil {
				return err
			}
			createdCount++
		}

		if createdCount > 0 {
			err := qtx.MarketCreateStaleJobsUpdateRepo(ctx, db.MarketCreateStaleJobsUpdateRepoParams{
				PendingSyncSha: pgtype.Text{String: input.ToSha, Valid: true},
				ID:             input.RepositoryID,
			})
			if err != nil {
				return err
			}
		}
		return nil
	})
	return createdCount, err
}
