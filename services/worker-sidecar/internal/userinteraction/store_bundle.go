package userinteraction

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// BundleRepoItem represents a linked repository inside an MCP bundle.
type BundleRepoItem struct {
	ID       string  `json:"id"`
	Owner    string  `json:"owner"`
	Repo     string  `json:"repo"`
	Category *string `json:"category"`
}

// BundleDetail represents full McpBundle entity with linked repositories.
type BundleDetail struct {
	ID           string           `json:"id"`
	Title        string           `json:"title"`
	Slug         string           `json:"slug"`
	Description  *string          `json:"description"`
	Badge        *string          `json:"badge"`
	IsPinned     bool             `json:"isPinned"`
	DisplayOrder int              `json:"displayOrder"`
	UseCount     int              `json:"useCount"`
	Repositories []BundleRepoItem `json:"repositories"`
	CreatedAt    string           `json:"createdAt"`
	UpdatedAt    string           `json:"updatedAt"`
}

// BundleCreateInput contains fields for creating a new bundle.
type BundleCreateInput struct {
	Title         string   `json:"title"`
	Slug          string   `json:"slug"`
	Description   *string  `json:"description"`
	Badge         *string  `json:"badge"`
	IsPinned      bool     `json:"isPinned"`
	DisplayOrder  int      `json:"displayOrder"`
	RepositoryIDs []string `json:"repositoryIds"`
}

// BundleUpdateInput contains fields for updating an existing bundle.
type BundleUpdateInput struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Description   *string  `json:"description"`
	Badge         *string  `json:"badge"`
	IsPinned      bool     `json:"isPinned"`
	DisplayOrder  int      `json:"displayOrder"`
	RepositoryIDs []string `json:"repositoryIds"`
}

// IncrementBundleUseCount increments the use count of a bundle by id or slug.
func (s *PgxStore) IncrementBundleUseCount(ctx context.Context, bundleID string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool is not initialized")
	}
	if bundleID == "" {
		return errors.New("bundleID cannot be empty")
	}
	return s.getQueries().IncrementBundleUseCount(ctx, bundleID)
}

// CreateBundle creates a bundle and associates repositories atomically.
func (s *PgxStore) CreateBundle(ctx context.Context, input BundleCreateInput) (*BundleDetail, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}
	if input.Title == "" {
		return nil, errors.New("title cannot be empty")
	}
	if input.Slug == "" {
		return nil, errors.New("slug cannot be empty")
	}

	var detail BundleDetail
	var createdAt, updatedAt time.Time

	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.getQueries().WithTx(tx)
		badge := "❖ 官方精选"
		if input.Badge != nil && *input.Badge != "" {
			badge = *input.Badge
		}

		var desc pgtype.Text
		if input.Description != nil {
			desc = pgtype.Text{String: *input.Description, Valid: true}
		}
		var bBadge pgtype.Text
		if badge != "" {
			bBadge = pgtype.Text{String: badge, Valid: true}
		}

		row, err := q.InsertMcpBundle(ctx, db.InsertMcpBundleParams{
			Title:        input.Title,
			Slug:         input.Slug,
			Description:  desc,
			Badge:        bBadge,
			IsPinned:     input.IsPinned,
			DisplayOrder: int32(input.DisplayOrder),
		})
		if err != nil {
			return fmt.Errorf("failed to insert mcp bundle: %w", err)
		}

		detail.ID = row.ID
		detail.Title = row.Title
		detail.Slug = row.Slug
		if row.Description.Valid {
			detail.Description = &row.Description.String
		}
		if row.Badge.Valid {
			detail.Badge = &row.Badge.String
		}
		detail.IsPinned = row.IsPinned
		detail.DisplayOrder = int(row.DisplayOrder)
		detail.UseCount = int(row.UseCount)
		createdAt = row.CreatedAt.Time
		updatedAt = row.UpdatedAt.Time

		// Connect repositories
		if len(input.RepositoryIDs) > 0 {
			for _, repoID := range input.RepositoryIDs {
				if repoID == "" {
					continue
				}
				if err := q.LinkBundleRepository(ctx, db.LinkBundleRepositoryParams{
					A: row.ID,
					B: repoID,
				}); err != nil {
					return fmt.Errorf("failed to link repository %s to bundle: %w", repoID, err)
				}
			}
		}

		// Fetch linked repositories
		repoRows, err := q.GetBundleRepositories(ctx, row.ID)
		if err != nil {
			return fmt.Errorf("failed to query bundle repositories: %w", err)
		}

		detail.Repositories = make([]BundleRepoItem, 0)
		for _, r := range repoRows {
			var cat *string
			if r.Category.Valid {
				cat = &r.Category.String
			}
			detail.Repositories = append(detail.Repositories, BundleRepoItem{
				ID:       r.ID,
				Owner:    r.Owner,
				Repo:     r.Repo,
				Category: cat,
			})
		}
		return nil
	})

	if err != nil {
		return nil, err
	}

	detail.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	detail.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return &detail, nil
}

// UpdateBundle updates an existing bundle and syncs repositories.
func (s *PgxStore) UpdateBundle(ctx context.Context, input BundleUpdateInput) (*BundleDetail, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}
	if input.ID == "" {
		return nil, errors.New("bundle id cannot be empty")
	}

	var detail BundleDetail
	var createdAt, updatedAt time.Time

	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.getQueries().WithTx(tx)
		var badge *string = input.Badge
		if input.Badge != nil && *input.Badge == "" {
			badge = nil
		}

		var desc pgtype.Text
		if input.Description != nil {
			desc = pgtype.Text{String: *input.Description, Valid: true}
		}
		var bBadge pgtype.Text
		if badge != nil {
			bBadge = pgtype.Text{String: *badge, Valid: true}
		}

		row, err := q.UpdateMcpBundle(ctx, db.UpdateMcpBundleParams{
			ID:           input.ID,
			Column2:      input.Title,
			Description:  desc,
			Badge:        bBadge,
			IsPinned:     input.IsPinned,
			DisplayOrder: int32(input.DisplayOrder),
		})
		if err != nil {
			return fmt.Errorf("failed to update mcp bundle: %w", err)
		}

		detail.ID = row.ID
		detail.Title = row.Title
		detail.Slug = row.Slug
		if row.Description.Valid {
			detail.Description = &row.Description.String
		}
		if row.Badge.Valid {
			detail.Badge = &row.Badge.String
		}
		detail.IsPinned = row.IsPinned
		detail.DisplayOrder = int(row.DisplayOrder)
		detail.UseCount = int(row.UseCount)
		createdAt = row.CreatedAt.Time
		updatedAt = row.UpdatedAt.Time

		// Reset linked repositories
		if err := q.ClearBundleRepositories(ctx, input.ID); err != nil {
			return fmt.Errorf("failed to clear old bundle repositories: %w", err)
		}

		if len(input.RepositoryIDs) > 0 {
			for _, repoID := range input.RepositoryIDs {
				if repoID == "" {
					continue
				}
				if err := q.LinkBundleRepository(ctx, db.LinkBundleRepositoryParams{
					A: input.ID,
					B: repoID,
				}); err != nil {
					return fmt.Errorf("failed to re-link repo %s: %w", repoID, err)
				}
			}
		}

		// Fetch linked repositories
		repoRows, err := q.GetBundleRepositories(ctx, input.ID)
		if err != nil {
			return fmt.Errorf("failed to query updated bundle repositories: %w", err)
		}

		detail.Repositories = make([]BundleRepoItem, 0)
		for _, r := range repoRows {
			var cat *string
			if r.Category.Valid {
				cat = &r.Category.String
			}
			detail.Repositories = append(detail.Repositories, BundleRepoItem{
				ID:       r.ID,
				Owner:    r.Owner,
				Repo:     r.Repo,
				Category: cat,
			})
		}
		return nil
	})

	if err != nil {
		return nil, err
	}

	detail.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	detail.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return &detail, nil
}

// DeleteBundle deletes a bundle and removes all relations atomically.
func (s *PgxStore) DeleteBundle(ctx context.Context, id string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool is not initialized")
	}
	if id == "" {
		return errors.New("bundle id cannot be empty")
	}

	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.getQueries().WithTx(tx)
		if err := q.ClearBundleRepositories(ctx, id); err != nil {
			return fmt.Errorf("failed to delete bundle relations: %w", err)
		}

		rowsAffected, err := q.DeleteMcpBundle(ctx, id)
		if err != nil {
			return fmt.Errorf("failed to delete mcp bundle: %w", err)
		}
		if rowsAffected == 0 {
			return errors.New("bundle not found")
		}
		return nil
	})
}
