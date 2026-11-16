package update

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/storeutil"
)

type DBExec = storeutil.DBTX
type dbExec = storeutil.DBTX

// ProjectionInvalidator abstracts MCP projection cache invalidation.
type ProjectionInvalidator interface {
	Invalidate(owner, repo string)
	InvalidateByID(repoID string)
}

// PgxStore provides Postgres-backed persistence for the update engine.
type PgxStore struct {
	pool      *pgxpool.Pool
	projStore ProjectionInvalidator
	queries   *db.Queries
}

var _ Store = (*PgxStore)(nil)

// NewPgxStore constructs a new PgxStore with the given connection pool.
func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{
		pool:    pool,
		queries: db.New(pool),
	}
}

// SetProjectionStore injects the projection store invalidator.
func (s *PgxStore) SetProjectionStore(ps ProjectionInvalidator) {
	s.projStore = ps
}

// GetRepoProfile fetches the repository profile JSON.
func (s *PgxStore) GetRepoProfile(ctx context.Context, repoID string) (*UpdateRepoProfile, error) {
	if s.pool == nil {
		return nil, nil
	}
	profileJSON, err := s.queries.GetRepoProfile(ctx, repoID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("query repository profile failed: %w", err)
	}
	if len(profileJSON) == 0 {
		return nil, nil
	}
	var profile UpdateRepoProfile
	if err := json.Unmarshal(profileJSON, &profile); err != nil {
		return nil, fmt.Errorf("unmarshal repoProfile failed: %w", err)
	}
	return &profile, nil
}

// GetDocuments queries document paths, titles, and summaries for a repository.
func (s *PgxStore) GetDocuments(ctx context.Context, repoID string, docOwnerID *string) ([]UpdateDocumentMeta, error) {
	if s.pool == nil {
		return nil, nil
	}
	ownerStr := ""
	if docOwnerID != nil {
		ownerStr = *docOwnerID
	}
	rows, err := s.queries.GetDocuments(ctx, db.GetDocumentsParams{
		RepositoryId: repoID,
		OwnerUserId:  pgtype.Text{String: ownerStr, Valid: ownerStr != ""},
	})
	if err != nil {
		return nil, fmt.Errorf("query documents failed: %w", err)
	}

	var docs []UpdateDocumentMeta
	for _, r := range rows {
		var title *string
		if r.Title.Valid {
			title = &r.Title.String
		}
		var summary *string
		if r.Summary.Valid {
			summary = &r.Summary.String
		}
		docs = append(docs, UpdateDocumentMeta{
			Path:    r.Path,
			Title:   title,
			Summary: summary,
		})
	}
	return docs, nil
}

// ListUpdatableRepos lists public auto-sync repositories needing update check.
func (s *PgxStore) ListUpdatableRepos(ctx context.Context, limit int) ([]StaleRepoRow, error) {
	rows, err := s.queries.ListUpdatableRepos(ctx, int32(limit))
	if err != nil {
		return nil, err
	}
	var out []StaleRepoRow
	for _, r := range rows {
		outRow := StaleRepoRow{
			ID:     r.ID,
			Owner:  r.Owner,
			Repo:   r.Repo,
			Branch: r.Branch,
			GitSha: r.GitSha.String,
		}
		if r.PendingSyncSha.Valid {
			outRow.PendingSyncSha = &r.PendingSyncSha.String
		}
		if r.RepoProfile != "" {
			_ = json.Unmarshal([]byte(r.RepoProfile), &outRow.RepoProfile)
		}
		out = append(out, outRow)
	}
	return out, nil
}

// ListProcessedSharedDocs lists shared PROCESSED documents matching paths.
func (s *PgxStore) ListProcessedSharedDocs(ctx context.Context, repositoryId string, paths []string) ([]DocIdPath, error) {
	rows, err := s.queries.ListProcessedSharedDocs(ctx, db.ListProcessedSharedDocsParams{
		RepositoryId: repositoryId,
		Paths:        paths,
	})
	if err != nil {
		return nil, err
	}
	var out []DocIdPath
	for _, r := range rows {
		out = append(out, DocIdPath{
			ID:   r.ID,
			Path: r.Path,
		})
	}
	return out, nil
}

// BusyUpdateJobDocIDs lists document IDs currently locked in active update jobs.
func (s *PgxStore) BusyUpdateJobDocIDs(ctx context.Context, repositoryId string) ([]string, error) {
	return s.queries.BusyUpdateJobDocIDs(ctx, repositoryId)
}

// CountActiveUpdateJobs counts update jobs in PENDING, CLAIMED, or TRIAL status.
func (s *PgxStore) CountActiveUpdateJobs(ctx context.Context, repositoryId string) (int, error) {
	count, err := s.queries.CountActiveUpdateJobs(ctx, repositoryId)
	return int(count), err
}

// CreateChapterUpdateJob creates a pending chapter update job.
func (s *PgxStore) CreateChapterUpdateJob(ctx context.Context, repositoryId, documentId, path, fromSha, toSha string) error {
	return s.queries.CreateChapterUpdateJob(ctx, db.CreateChapterUpdateJobParams{
		RepositoryId: repositoryId,
		DocumentId:   documentId,
		Path:         path,
		FromSha:      fromSha,
		ToSha:        toSha,
	})
}

// SetPendingSyncSha marks pendingSyncSha on repository.
func (s *PgxStore) SetPendingSyncSha(ctx context.Context, repositoryId, sha string) error {
	return s.queries.SetPendingSyncSha(ctx, db.SetPendingSyncShaParams{
		PendingSyncSha: pgtype.Text{String: sha, Valid: true},
		ID:             repositoryId,
	})
}

// AdvanceSyncBaseline advances gitSha, clears pendingSyncSha and hasUpstreamUpdate.
func (s *PgxStore) AdvanceSyncBaseline(ctx context.Context, repositoryId, toSha string) error {
	return s.queries.AdvanceSyncBaseline(ctx, db.AdvanceSyncBaselineParams{
		GitSha: pgtype.Text{String: toSha, Valid: true},
		ID:     repositoryId,
	})
}

// ClearUpstreamUpdate clears hasUpstreamUpdate and pendingSyncSha.
func (s *PgxStore) ClearUpstreamUpdate(ctx context.Context, repositoryId string) error {
	return s.queries.ClearUpstreamUpdate(ctx, repositoryId)
}

// ReleaseExpiredClaims releases CLAIMED jobs past their claim deadline.
func (s *PgxStore) ReleaseExpiredClaims(ctx context.Context) (int64, error) {
	return s.queries.MarketReleaseExpiredClaims(ctx)
}

// FailTrialsWithoutStaging transitions expired TRIAL jobs without staging to FAILED.
func (s *PgxStore) FailTrialsWithoutStaging(ctx context.Context) (int64, error) {
	return s.queries.MarketFailTrialsWithoutStaging(ctx)
}

// LeaseUpdateIfHeldOrExpired updates scheduler lease if held or expired.
func (s *PgxStore) LeaseUpdateIfHeldOrExpired(ctx context.Context, key, owner string, until time.Time) (int64, error) {
	return s.queries.LeaseUpdateIfHeldOrExpired(ctx, db.LeaseUpdateIfHeldOrExpiredParams{
		OwnerId:     owner,
		LockedUntil: pgtype.Timestamp{Time: until, Valid: true},
		Key:         key,
	})
}

// LeaseInsert inserts a new scheduler lease.
func (s *PgxStore) LeaseInsert(ctx context.Context, key, owner string, until time.Time) error {
	return s.queries.LeaseInsert(ctx, db.LeaseInsertParams{
		Key:         key,
		OwnerId:     owner,
		LockedUntil: pgtype.Timestamp{Time: until, Valid: true},
	})
}

// LeaseDelete removes a scheduler lease held by owner.
func (s *PgxStore) LeaseDelete(ctx context.Context, key, owner string) error {
	return s.queries.LeaseDelete(ctx, db.LeaseDeleteParams{
		Key:     key,
		OwnerId: owner,
	})
}

// CleanExpiredLeases purges leases expired before cutoff.
func (s *PgxStore) CleanExpiredLeases(ctx context.Context, expiredBefore time.Time) (int64, error) {
	return s.queries.CleanExpiredLeases(ctx, pgtype.Timestamp{Time: expiredBefore, Valid: true})
}

// CreateUpdateRun creates a new ImportUpdateRun record with status PLANNED.
func (s *PgxStore) CreateUpdateRun(ctx context.Context, p CreateUpdateRunParams) (string, error) {
	status := p.Status
	if status == "" {
		status = "PLANNED"
	}
	var planJSON []byte
	if p.Plan != nil {
		planJSON, _ = json.Marshal(p.Plan)
	}
	var candJSON []byte
	if p.CandidateSet != nil {
		candJSON, _ = json.Marshal(p.CandidateSet)
	}
	var statsJSON []byte
	if p.Stats != nil {
		statsJSON, _ = json.Marshal(p.Stats)
	}

	return s.queries.CreateUpdateRun(ctx, db.CreateUpdateRunParams{
		RepositoryId: p.RepositoryID,
		UserId:       p.UserID,
		FromSha:      p.FromSha,
		ToSha:        p.ToSha,
		Status:       status,
		Plan:         planJSON,
		CandidateSet: candJSON,
		Stats:        statsJSON,
	})
}

// ClaimUpdateRun atomically transitions a run from PLANNED or FAILED to APPLYING.
func (s *PgxStore) ClaimUpdateRun(ctx context.Context, id string) (bool, error) {
	rows, err := s.queries.ClaimUpdateRun(ctx, id)
	return rows > 0, err
}

// UpdateRunStatus updates status, error message, applied timestamp, and stats of an ImportUpdateRun.
func (s *PgxStore) UpdateRunStatus(ctx context.Context, id string, p UpdateRunStatusParams) error {
	var statsJSON []byte
	if p.Stats != nil {
		statsJSON, _ = json.Marshal(p.Stats)
	}
	finishedAt := pgtype.Timestamp{}
	if p.FinishedAt != nil {
		finishedAt.Time = *p.FinishedAt
		finishedAt.Valid = true
	}

	return s.queries.UpdateRunStatus(ctx, db.UpdateRunStatusParams{
		Status:     p.Status,
		FinishedAt: finishedAt,
		Stats:      statsJSON,
		ID:         id,
	})
}
