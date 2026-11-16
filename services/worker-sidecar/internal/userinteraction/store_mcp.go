package userinteraction

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

const maxTokensPerUser = 20

// McpTokenSummary represents a safe summary of an MCP API Token without secret credentials.
type McpTokenSummary struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Prefix     string  `json:"prefix"`
	LastUsedAt *string `json:"lastUsedAt"`
	CreatedAt  string  `json:"createdAt"`
	RevokedAt  *string `json:"revokedAt"`
}

// McpTokenCreateInput represents input for creating a new MCP API token.
type McpTokenCreateInput struct {
	UserID         string  `json:"userId"`
	Name           string  `json:"name"`
	TokenHash      string  `json:"tokenHash"`
	EncryptedToken *string `json:"encryptedToken,omitempty"`
	Prefix         string  `json:"prefix"`
}

// McpTokenCreatedRecord represents the created token record returned by database.
type McpTokenCreatedRecord struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Prefix    string `json:"prefix"`
	CreatedAt string `json:"createdAt"`
}

// McpTokenRevokeInput represents input for revoking an MCP API token.
type McpTokenRevokeInput struct {
	ID     string `json:"id"`
	UserID string `json:"userId"`
	All    bool   `json:"all"`
}

// ListMcpTokens lists MCP API tokens for a user, excluding hashes and secrets.
func (s *PgxStore) ListMcpTokens(ctx context.Context, userID string) ([]McpTokenSummary, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	q := s.getQueries()
	rows, err := q.ListMcpTokensByUserID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query mcp tokens: %w", err)
	}

	items := make([]McpTokenSummary, 0, len(rows))
	for _, row := range rows {
		item := McpTokenSummary{
			ID:     row.ID,
			Name:   row.Name,
			Prefix: row.Prefix,
		}
		if row.CreatedAt.Valid {
			item.CreatedAt = row.CreatedAt.Time.UTC().Format(time.RFC3339)
		}
		if row.LastUsedAt.Valid {
			str := row.LastUsedAt.Time.UTC().Format(time.RFC3339)
			item.LastUsedAt = &str
		}
		if row.RevokedAt.Valid {
			str := row.RevokedAt.Time.UTC().Format(time.RFC3339)
			item.RevokedAt = &str
		}
		items = append(items, item)
	}

	return items, nil
}

// CreateMcpToken creates a new MCP API token after verifying the active token quota.
func (s *PgxStore) CreateMcpToken(ctx context.Context, input McpTokenCreateInput) (*McpTokenCreatedRecord, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}
	if input.UserID == "" {
		return nil, errors.New("userId cannot be empty")
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return nil, errors.New("name cannot be empty")
	}
	if input.TokenHash == "" {
		return nil, errors.New("tokenHash cannot be empty")
	}
	prefix := strings.TrimSpace(input.Prefix)
	if prefix == "" {
		return nil, errors.New("prefix cannot be empty")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	qtx := s.getQueries().WithTx(tx)
	activeCount, err := qtx.CountActiveMcpTokensByUserID(ctx, input.UserID)
	if err != nil {
		return nil, fmt.Errorf("failed to check active tokens count: %w", err)
	}

	if activeCount >= maxTokensPerUser {
		return nil, ErrMaxTokensExceeded
	}

	tokenID := uuid.NewString()
	var encToken pgtype.Text
	if input.EncryptedToken != nil {
		encToken = pgtype.Text{String: *input.EncryptedToken, Valid: true}
	}

	row, err := qtx.CreateMcpToken(ctx, db.CreateMcpTokenParams{
		ID:             tokenID,
		UserId:         input.UserID,
		Name:           name,
		TokenHash:      input.TokenHash,
		EncryptedToken: encToken,
		Prefix:         prefix,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to insert mcp token: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit mcp token creation: %w", err)
	}

	createdAtStr := ""
	if row.CreatedAt.Valid {
		createdAtStr = row.CreatedAt.Time.UTC().Format(time.RFC3339)
	}

	return &McpTokenCreatedRecord{
		ID:        row.ID,
		Name:      row.Name,
		Prefix:    row.Prefix,
		CreatedAt: createdAtStr,
	}, nil
}

// RevokeMcpToken soft-revokes an MCP API token by setting revokedAt to NOW().
func (s *PgxStore) RevokeMcpToken(ctx context.Context, input McpTokenRevokeInput) (int64, error) {
	if s.pool == nil {
		return 0, fmt.Errorf("database pool is not initialized")
	}
	if input.UserID == "" {
		return 0, errors.New("userId cannot be empty")
	}

	q := s.getQueries()
	if input.All {
		affected, err := q.RevokeAllMcpTokens(ctx, input.UserID)
		if err != nil {
			return 0, fmt.Errorf("failed to revoke all mcp tokens: %w", err)
		}
		return affected, nil
	}

	if input.ID == "" {
		return 0, errors.New("id cannot be empty")
	}

	affected, err := q.RevokeMcpTokenByID(ctx, db.RevokeMcpTokenByIDParams{
		ID:     input.ID,
		UserId: input.UserID,
	})
	if err != nil {
		return 0, fmt.Errorf("failed to revoke mcp token: %w", err)
	}

	if affected == 0 {
		return 0, ErrMcpTokenNotFound
	}

	return affected, nil
}

// TouchMcpTokenUsage updates lastUsedAt for an active MCP API token.
func (s *PgxStore) TouchMcpTokenUsage(ctx context.Context, tokenID string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool is not initialized")
	}
	if tokenID == "" {
		return errors.New("token id cannot be empty")
	}

	q := s.getQueries()
	if err := q.TouchMcpTokenUsage(ctx, tokenID); err != nil {
		return fmt.Errorf("failed to touch mcp token: %w", err)
	}
	return nil
}
