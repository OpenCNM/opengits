package userinteraction

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

type RepoPatchInput struct {
	ID                     string  `json:"id"`
	GitSha                 *string `json:"gitSha,omitempty"`
	HasUpstreamUpdate      *bool   `json:"hasUpstreamUpdate,omitempty"`
	UpstreamEtag           *string `json:"upstreamEtag,omitempty"`
	ClearUpstreamEtag      bool    `json:"clearUpstreamEtag,omitempty"`
	TouchUpstreamCheckedAt bool    `json:"touchUpstreamCheckedAt,omitempty"`
	SourceClusterKey       *string `json:"sourceClusterKey,omitempty"`
	Skeleton               *string `json:"skeleton,omitempty"`
	SkeletonHash           *string `json:"skeletonHash,omitempty"`
	IsPublic               *bool   `json:"isPublic,omitempty"`
	TouchPublishedAt       bool    `json:"touchPublishedAt,omitempty"`
	ClearPublishedAt       bool    `json:"clearPublishedAt,omitempty"`
	TouchRelayNotifiedAt   bool    `json:"touchRelayNotifiedAt,omitempty"`
	ClearRelayNotifiedAt   bool    `json:"clearRelayNotifiedAt,omitempty"`
	ReviewStatus           *string `json:"reviewStatus,omitempty"`
	ReviewAutoApproved     *bool   `json:"reviewAutoApproved,omitempty"`
	RejectionReason        *string `json:"rejectionReason,omitempty"`
	ClearRejectionReason   bool    `json:"clearRejectionReason,omitempty"`
	TouchReviewedAt        bool    `json:"touchReviewedAt,omitempty"`
	RelayEnabled           *bool   `json:"relayEnabled,omitempty"`
	McpStatus              *string `json:"mcpStatus,omitempty"`
	AutoSyncEnabled        *bool   `json:"autoSyncEnabled,omitempty"`
	QualityHold            *bool   `json:"qualityHold,omitempty"`
	RepoProfile            any     `json:"repoProfile,omitempty"`
	ReviewPipeline         any     `json:"reviewPipeline,omitempty"`
	ReviewLlm              any     `json:"reviewLlm,omitempty"`
	ClearReviewLlm         bool    `json:"clearReviewLlm,omitempty"`
	ClearUnpublishCooldown bool    `json:"clearUnpublishCooldown,omitempty"`
}

type RepoBatchPatchInput struct {
	IDs                    []string `json:"ids"`
	HasUpstreamUpdate      *bool    `json:"hasUpstreamUpdate,omitempty"`
	TouchUpstreamCheckedAt bool     `json:"touchUpstreamCheckedAt,omitempty"`
	ClearUpstreamEtag      bool     `json:"clearUpstreamEtag,omitempty"`
	McpStatus              *string  `json:"mcpStatus,omitempty"`
}

type RepoIncrementInput struct {
	ID                  *string  `json:"id,omitempty"`
	IDs                 []string `json:"ids,omitempty"`
	TranscriptionTokens *int     `json:"transcriptionTokens,omitempty"`
	McpCallCount        *int     `json:"mcpCallCount,omitempty"`
	AutoSwapCount       *int     `json:"autoSwapCount,omitempty"`
}

type RepoIncrementResult struct {
	OK            bool `json:"ok"`
	AutoSwapCount *int `json:"autoSwapCount,omitempty"`
}

type RepoDeleteInput struct {
	ID      *string `json:"id,omitempty"`
	Owner   *string `json:"owner,omitempty"`
	Repo    *string `json:"repo,omitempty"`
	Branch  *string `json:"branch,omitempty"`
	Edition *string `json:"edition,omitempty"`
}

type RepoUnpublishInput struct {
	ID     string `json:"id"`
	UserID string `json:"userId"`
}

type RepoUnpublishResult struct {
	OK                          bool  `json:"ok"`
	IsPublic                    bool  `json:"isPublic"`
	CancelledPendingGrantsCount int64 `json:"cancelledPendingGrantsCount"`
	DetachedSavedReposCount     int64 `json:"detachedSavedReposCount"`
}

type RepoPromoteEditionInput struct {
	ID     string `json:"id"`
	UserID string `json:"userId"`
}

type RepoPromoteEditionResult struct {
	OK               bool   `json:"ok"`
	PromotedRepoID   string `json:"promotedRepoId"`
	OldDefaultRepoID string `json:"oldDefaultRepoId,omitempty"`
	MigratedSaves    int64  `json:"migratedSaves"`
}

func (s *PgxStore) PatchRepo(ctx context.Context, input RepoPatchInput) error {
	if s == nil || s.pool == nil {
		return errors.New("database pool is not initialized")
	}
	id := strings.TrimSpace(input.ID)
	if id == "" {
		return errors.New("id is required")
	}

	setClauses := make([]string, 0, 20)
	setClauses = append(setClauses, `"updatedAt" = now()`)
	args := []any{id}
	argIdx := 2

	if input.GitSha != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"gitSha" = $%d`, argIdx))
		args = append(args, *input.GitSha)
		argIdx++
	}
	if input.HasUpstreamUpdate != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"hasUpstreamUpdate" = $%d`, argIdx))
		args = append(args, *input.HasUpstreamUpdate)
		argIdx++
	}
	if input.TouchUpstreamCheckedAt {
		setClauses = append(setClauses, `"upstreamCheckedAt" = now()`)
	}
	if input.ClearUpstreamEtag {
		setClauses = append(setClauses, `"upstreamEtag" = NULL`)
	} else if input.UpstreamEtag != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"upstreamEtag" = $%d`, argIdx))
		args = append(args, *input.UpstreamEtag)
		argIdx++
	}
	if input.SourceClusterKey != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"sourceClusterKey" = $%d`, argIdx))
		args = append(args, *input.SourceClusterKey)
		argIdx++
	}
	if input.Skeleton != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"skeleton" = $%d`, argIdx))
		args = append(args, *input.Skeleton)
		argIdx++
	}
	if input.SkeletonHash != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"skeletonHash" = $%d`, argIdx))
		args = append(args, *input.SkeletonHash)
		argIdx++
	}
	if input.IsPublic != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"isPublic" = $%d`, argIdx))
		args = append(args, *input.IsPublic)
		argIdx++
		if *input.IsPublic {
			setClauses = append(setClauses, `"unpublishCooldownUntil" = NULL`, `"unpublishRequestedAt" = NULL`)
		}
	} else if input.ClearUnpublishCooldown {
		setClauses = append(setClauses, `"unpublishCooldownUntil" = NULL`, `"unpublishRequestedAt" = NULL`)
	}
	if input.TouchPublishedAt {
		setClauses = append(setClauses, `"publishedAt" = now()`)
	} else if input.ClearPublishedAt {
		setClauses = append(setClauses, `"publishedAt" = NULL`)
	}
	if input.TouchRelayNotifiedAt {
		setClauses = append(setClauses, `"relayNotifiedAt" = now()`)
	} else if input.ClearRelayNotifiedAt {
		setClauses = append(setClauses, `"relayNotifiedAt" = NULL`)
	}
	if input.ReviewStatus != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"reviewStatus" = $%d`, argIdx))
		args = append(args, *input.ReviewStatus)
		argIdx++
	}
	if input.ReviewAutoApproved != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"reviewAutoApproved" = $%d`, argIdx))
		args = append(args, *input.ReviewAutoApproved)
		argIdx++
	}
	if input.ClearRejectionReason {
		setClauses = append(setClauses, `"rejectionReason" = NULL`)
	} else if input.RejectionReason != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"rejectionReason" = $%d`, argIdx))
		args = append(args, *input.RejectionReason)
		argIdx++
	}
	if input.TouchReviewedAt {
		setClauses = append(setClauses, `"reviewedAt" = now()`)
	}
	if input.RelayEnabled != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"relayEnabled" = $%d`, argIdx))
		args = append(args, *input.RelayEnabled)
		argIdx++
	}
	if input.McpStatus != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"mcpStatus" = $%d`, argIdx))
		args = append(args, *input.McpStatus)
		argIdx++
	}
	if input.AutoSyncEnabled != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"autoSyncEnabled" = $%d`, argIdx))
		args = append(args, *input.AutoSyncEnabled)
		argIdx++
	}
	if input.QualityHold != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"qualityHold" = $%d`, argIdx))
		args = append(args, *input.QualityHold)
		argIdx++
	}
	if input.RepoProfile != nil {
		b, err := json.Marshal(input.RepoProfile)
		if err == nil {
			// Preserve existing bookAudit JSON key when replacing repoProfile.
			setClauses = append(setClauses, fmt.Sprintf(`"repoProfile" = $%d::jsonb || jsonb_strip_nulls(jsonb_build_object('bookAudit', "repoProfile" -> 'bookAudit'))`, argIdx))
			args = append(args, string(b))
			argIdx++
		}
	}
	if input.ReviewPipeline != nil {
		b, err := json.Marshal(input.ReviewPipeline)
		if err == nil {
			setClauses = append(setClauses, fmt.Sprintf(`"reviewPipeline" = $%d::jsonb`, argIdx))
			args = append(args, string(b))
			argIdx++
		}
	}
	if input.ClearReviewLlm {
		setClauses = append(setClauses, `"reviewLlm" = NULL`)
	} else if input.ReviewLlm != nil {
		b, err := json.Marshal(input.ReviewLlm)
		if err == nil {
			setClauses = append(setClauses, fmt.Sprintf(`"reviewLlm" = $%d::jsonb`, argIdx))
			args = append(args, string(b))
			argIdx++
		}
	}

	query := fmt.Sprintf(`UPDATE "Repository" SET %s WHERE "id" = $1`, strings.Join(setClauses, ", "))
	tag, err := s.pool.Exec(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("failed to patch repository: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrRepositoryNotFound
	}
	return nil
}

func (s *PgxStore) BatchPatchRepos(ctx context.Context, input RepoBatchPatchInput) (int64, error) {
	if s == nil || s.pool == nil {
		return 0, errors.New("database pool is not initialized")
	}
	if len(input.IDs) == 0 {
		return 0, nil
	}

	setClauses := make([]string, 0, 5)
	setClauses = append(setClauses, `"updatedAt" = now()`)
	args := []any{input.IDs}
	argIdx := 2

	if input.HasUpstreamUpdate != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"hasUpstreamUpdate" = $%d`, argIdx))
		args = append(args, *input.HasUpstreamUpdate)
		argIdx++
	}
	if input.TouchUpstreamCheckedAt {
		setClauses = append(setClauses, `"upstreamCheckedAt" = now()`)
	}
	if input.ClearUpstreamEtag {
		setClauses = append(setClauses, `"upstreamEtag" = NULL`)
	}
	if input.McpStatus != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"mcpStatus" = $%d`, argIdx))
		args = append(args, *input.McpStatus)
		argIdx++
	}

	query := fmt.Sprintf(`UPDATE "Repository" SET %s WHERE "id" = ANY($1)`, strings.Join(setClauses, ", "))
	tag, err := s.pool.Exec(ctx, query, args...)
	if err != nil {
		return 0, fmt.Errorf("failed to batch patch repositories: %w", err)
	}
	return tag.RowsAffected(), nil
}

func (s *PgxStore) IncrementRepoCounters(ctx context.Context, input RepoIncrementInput) (*RepoIncrementResult, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("database pool is not initialized")
	}

	res := &RepoIncrementResult{OK: true}
	q := s.getQueries()

	if input.TranscriptionTokens != nil && *input.TranscriptionTokens > 0 && input.ID != nil && strings.TrimSpace(*input.ID) != "" {
		if err := q.IncrementRepoTranscriptionTokens(ctx, db.IncrementRepoTranscriptionTokensParams{
			TranscriptionTokens: int32(*input.TranscriptionTokens),
			ID:                  *input.ID,
		}); err != nil {
			return nil, fmt.Errorf("failed to increment transcriptionTokens: %w", err)
		}
	}

	if input.McpCallCount != nil && *input.McpCallCount > 0 {
		if input.ID != nil && strings.TrimSpace(*input.ID) != "" {
			if err := q.IncrementRepoMcpCallCount(ctx, db.IncrementRepoMcpCallCountParams{
				McpCallCount: int32(*input.McpCallCount),
				ID:           *input.ID,
			}); err != nil {
				return nil, fmt.Errorf("failed to increment mcpCallCount: %w", err)
			}
		} else if len(input.IDs) > 0 {
			if err := q.BatchIncrementRepoMcpCallCount(ctx, db.BatchIncrementRepoMcpCallCountParams{
				McpCallCount: int32(*input.McpCallCount),
				Column2:      input.IDs,
			}); err != nil {
				return nil, fmt.Errorf("failed to batch increment mcpCallCount: %w", err)
			}
		}
	}

	if input.AutoSwapCount != nil && *input.AutoSwapCount > 0 && input.ID != nil && strings.TrimSpace(*input.ID) != "" {
		autoSwapCount, err := q.IncrementRepoAutoSwapCount(ctx, db.IncrementRepoAutoSwapCountParams{
			AutoSwapCount: int32(*input.AutoSwapCount),
			ID:            *input.ID,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to increment autoSwapCount: %w", err)
		}
		n := int(autoSwapCount)
		res.AutoSwapCount = &n
	}

	return res, nil
}

func (s *PgxStore) DeleteRepo(ctx context.Context, input RepoDeleteInput) (int64, error) {
	if s == nil || s.pool == nil {
		return 0, errors.New("database pool is not initialized")
	}
	q := s.getQueries()

	if input.ID != nil && strings.TrimSpace(*input.ID) != "" {
		rowsAffected, err := q.DeleteRepoById(ctx, strings.TrimSpace(*input.ID))
		if err != nil {
			return 0, fmt.Errorf("failed to delete repository by id: %w", err)
		}
		return rowsAffected, nil
	}

	if input.Owner != nil && input.Repo != nil {
		branch := "main"
		if input.Branch != nil && strings.TrimSpace(*input.Branch) != "" {
			branch = strings.TrimSpace(*input.Branch)
		}
		edition := ""
		if input.Edition != nil {
			edition = *input.Edition
		}
		rowsAffected, err := q.DeleteRepoByTuple(ctx, db.DeleteRepoByTupleParams{
			Owner:   strings.TrimSpace(*input.Owner),
			Repo:    strings.TrimSpace(*input.Repo),
			Branch:  branch,
			Edition: edition,
		})
		if err != nil {
			return 0, fmt.Errorf("failed to delete repository by tuple: %w", err)
		}
		return rowsAffected, nil
	}

	return 0, errors.New("either id or (owner, repo) must be provided")
}

func (s *PgxStore) UnpublishRepo(ctx context.Context, input RepoUnpublishInput) (*RepoUnpublishResult, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("database pool is not initialized")
	}
	repoID := strings.TrimSpace(input.ID)
	if repoID == "" {
		return nil, errors.New("id is required")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin unpublish transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	txQueries := s.getQueries().WithTx(tx)

	repoState, err := txQueries.GetRepoUnpublishState(ctx, repoID)
	if err != nil {
		return nil, ErrRepositoryNotFound
	}
	if !repoState.IsPublic {
		return nil, errors.New("repository is already private or not public")
	}

	if _, err := txQueries.SetRepoUnpublish(ctx, repoID); err != nil {
		return nil, fmt.Errorf("failed to set repository unpublish state: %w", err)
	}

	cancelledCount, err := txQueries.CancelPendingCreditGrantsByRepo(ctx, repoID)
	if err != nil {
		return nil, fmt.Errorf("failed to cancel pending credits: %w", err)
	}

	detachedCount, err := txQueries.DetachSavedReposByRepo(ctx, repoID)
	if err != nil {
		return nil, fmt.Errorf("failed to detach reader saved repos: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit unpublish transaction: %w", err)
	}

	return &RepoUnpublishResult{
		OK:                          true,
		IsPublic:                    false,
		CancelledPendingGrantsCount: cancelledCount,
		DetachedSavedReposCount:     detachedCount,
	}, nil
}

func (s *PgxStore) PromoteEditionRepo(ctx context.Context, input RepoPromoteEditionInput) (*RepoPromoteEditionResult, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("database pool is not initialized")
	}
	targetID := strings.TrimSpace(input.ID)
	if targetID == "" {
		return nil, errors.New("id is required")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin promote edition transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	txQueries := s.getQueries().WithTx(tx)

	targetRepo, err := txQueries.GetRepoForPromotion(ctx, targetID)
	if err != nil {
		return nil, ErrRepositoryNotFound
	}
	if strings.TrimSpace(targetRepo.Edition) == "" {
		return nil, errors.New("repository is already the default edition")
	}

	var oldDefaultRepoID string
	var migratedSaves int64

	defaultRepo, err := txQueries.GetDefaultRepoForPromotion(ctx, db.GetDefaultRepoForPromotionParams{
		Owner:  targetRepo.Owner,
		Repo:   targetRepo.Repo,
		Branch: targetRepo.Branch,
		ID:     targetRepo.ID,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("failed to check existing default repository: %w", err)
	}
	if err == nil && defaultRepo.ID != "" {
		oldDefaultRepoID = defaultRepo.ID

		migratedSaves, err = txQueries.MigrateSavedReposForPromotion(ctx, db.MigrateSavedReposForPromotionParams{
			RepositoryId:   targetRepo.ID,
			RepositoryId_2: oldDefaultRepoID,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to migrate saved repositories: %w", err)
		}

		if _, err := txQueries.MigrateHelpfulVotesForPromotion(ctx, db.MigrateHelpfulVotesForPromotionParams{
			RepositoryId:   targetRepo.ID,
			RepositoryId_2: oldDefaultRepoID,
		}); err != nil {
			return nil, fmt.Errorf("failed to migrate helpful votes: %w", err)
		}

		if _, err := txQueries.MigrateImportRecordsForPromotion(ctx, db.MigrateImportRecordsForPromotionParams{
			RepositoryId:   targetRepo.ID,
			RepositoryId_2: oldDefaultRepoID,
		}); err != nil {
			return nil, fmt.Errorf("failed to migrate import records: %w", err)
		}

		if _, err := txQueries.MigrateReadingProgressForPromotion(ctx, db.MigrateReadingProgressForPromotionParams{
			RepositoryId:   targetRepo.ID,
			RepositoryId_2: oldDefaultRepoID,
		}); err != nil {
			return nil, fmt.Errorf("failed to migrate reading progress: %w", err)
		}

		if _, err := txQueries.DeleteRepoById(ctx, oldDefaultRepoID); err != nil {
			return nil, fmt.Errorf("failed to delete old default repository: %w", err)
		}
	}

	if _, err := txQueries.PromoteRepoToDefault(ctx, targetRepo.ID); err != nil {
		return nil, fmt.Errorf("failed to promote repository to default: %w", err)
	}

	if _, err := txQueries.DeleteDuplicatePrivateDocsForPromotion(ctx, targetRepo.ID); err != nil {
		return nil, fmt.Errorf("failed to clean duplicate documents for promotion: %w", err)
	}
	if _, err := txQueries.TransferRepoDocsToSharedForPromotion(ctx, targetRepo.ID); err != nil {
		return nil, fmt.Errorf("failed to transfer documents to shared: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit promote edition transaction: %w", err)
	}

	return &RepoPromoteEditionResult{
		OK:               true,
		PromotedRepoID:   targetRepo.ID,
		OldDefaultRepoID: oldDefaultRepoID,
		MigratedSaves:    migratedSaves,
	}, nil
}
