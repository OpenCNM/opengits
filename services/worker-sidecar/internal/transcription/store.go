package transcription

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/policy"
)

type EnqueueJobParams struct {
	DocumentID  string
	RequestedBy string
	Priority    int
	Options     any
}

type SaveCheckpointParams struct {
	DocumentID  string
	RequestedBy string
	Fingerprint string
	Index       int
	Total       int
	Content     string
}

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

// Guards on status='RUNNING' so stale workers after orphan reap cannot overwrite a re-claimed job.
func (s *PgxStore) CompleteTranscriptionJob(ctx context.Context, jobId string) error {
	return s.queries.TranscriptionCompleteJob(ctx, jobId)
}

type TranscriptionClaim struct {
	ID          string
	DocumentID  string
	RequestedBy string
	Options     string
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

// Uses COALESCE(updatedAt, claimedAt) dead-man's switch so active streaming jobs are not reaped.
func (s *PgxStore) ReapStaleTranscriptionJobs(ctx context.Context, staleBefore time.Time) (int64, error) {
	var totalReaped int64
	totalReaped, err := s.queries.TranscriptionReapStaleJobs(ctx, pgtype.Timestamp{Time: staleBefore, Valid: true})
	if err != nil {
		return 0, err
	}
	return totalReaped, nil
}

func (s *PgxStore) DeferTranscriptionJob(ctx context.Context, jobId string) (bool, error) {
	rowsAffected, err := s.queries.TranscriptionDeferJob(ctx, jobId)
	if err != nil {
		return false, err
	}
	return rowsAffected == 1, nil
}

func (s *PgxStore) FailTranscriptionJobExhausted(ctx context.Context, jobId, message string) (bool, error) {
	var rowsAffected int64
	var err error
	permanent := isPermanentStructuredErrStr(message)
	if permanent {
		rowsAffected, err = s.queries.TranscriptionFailJobImmediate(ctx, db.TranscriptionFailJobImmediateParams{
			Message: message,
			ID:      jobId,
		})
	} else {
		rowsAffected, err = s.queries.TranscriptionFailJobExhausted(ctx, db.TranscriptionFailJobExhaustedParams{
			Message: message,
			ID:      jobId,
		})
	}
	if err != nil {
		return false, err
	}
	if rowsAffected == 1 {
		_ = s.queries.TranscriptionSetDocErrorExhausted(ctx, db.TranscriptionSetDocErrorExhaustedParams{
			Message: message,
			ID:      jobId,
		})
		_, _ = s.queries.InsertTutorialTranscriptionFailedNotification(ctx, db.InsertTutorialTranscriptionFailedNotificationParams{
			Message: message,
			JobID:   jobId,
		})
		return true, nil
	}
	if permanent {
		return false, nil
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

func (s *PgxStore) EmergencyReadOnly(ctx context.Context) (bool, error) {
	v, err := s.queries.TranscriptionEmergencyReadOnly(ctx)
	if err != nil {
		return false, nil
	}
	return v, nil
}

func (s *PgxStore) ReadRuntimePolicy(ctx context.Context) (policy.RuntimePolicy, error) {
	row, err := s.queries.TranscriptionRuntimePolicy(ctx)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return policy.RuntimePolicy{}, nil
		}
		return policy.RuntimePolicy{}, err
	}
	rt := policy.RuntimePolicy{
		EmergencyReadOnly: row.EmergencyReadOnly,
	}
	if row.TranscriptionConcurrency.Valid {
		v := int(row.TranscriptionConcurrency.Int32)
		rt.TranscriptionConcurrency = &v
	}
	if row.TranscriptionChunkConcurrency.Valid {
		v := int(row.TranscriptionChunkConcurrency.Int32)
		rt.TranscriptionChunkConcurrency = &v
	}
	return rt, nil
}

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
