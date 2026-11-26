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

var (
	ErrJobNotFound       = errors.New("job not found")
	ErrDocNotFound       = errors.New("document not found")
	ErrJobInvalidState   = errors.New("invalid job state")
	ErrJobAlreadyClaimed = errors.New("job already claimed")
)

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

// Require status = 'CLAIMED' and claimedUntil > now() so expired leases cannot be renewed.
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

		// Load staged content inside the tx and roll back if empty to prevent dangling contentId.
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
