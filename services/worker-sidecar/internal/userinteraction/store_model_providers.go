package userinteraction

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// UserModelProviderRecord represents the complete database row for UserModelProvider.
type UserModelProviderRecord struct {
	ID            string   `json:"id"`
	UserID        string   `json:"userId"`
	ProviderKey   string   `json:"providerKey"`
	Name          string   `json:"name"`
	BaseURL       string   `json:"baseUrl"`
	APIKey        string   `json:"apiKey"`
	APIFormat     string   `json:"apiFormat"`
	Models        []string `json:"models"`
	SelectedModel string   `json:"selectedModel"`
	IsActive      bool     `json:"isActive"`
	HealthStatus  string   `json:"healthStatus"`
	LatencyMs     *int     `json:"latencyMs"`
	LastError     *string  `json:"lastError"`
	LastTestedAt  *string  `json:"lastTestedAt"`
	CreatedAt     string   `json:"createdAt"`
	UpdatedAt     string   `json:"updatedAt"`
}

// UserModelProviderView represents the sanitized model provider returned to clients.
type UserModelProviderView struct {
	ID            string   `json:"id"`
	ProviderKey   string   `json:"providerKey"`
	Name          string   `json:"name"`
	BaseURL       string   `json:"baseUrl"`
	MaskedApiKey  string   `json:"maskedApiKey"`
	HasApiKey     bool     `json:"hasApiKey"`
	APIFormat     string   `json:"apiFormat"`
	Models        []string `json:"models"`
	SelectedModel string   `json:"selectedModel"`
	IsActive      bool     `json:"isActive"`
	HealthStatus  string   `json:"healthStatus"`
	LatencyMs     *int     `json:"latencyMs"`
	LastError     *string  `json:"lastError"`
	LastTestedAt  *string  `json:"lastTestedAt"`
	CreatedAt     string   `json:"createdAt"`
	UpdatedAt     string   `json:"updatedAt"`
}

// UserModelProviderUpsertInput represents parameters to create or update a model provider.
type UserModelProviderUpsertInput struct {
	UserID          string   `json:"userId"`
	ProviderKey     string   `json:"providerKey"`
	Name            string   `json:"name"`
	BaseURL         string   `json:"baseUrl"`
	EncryptedApiKey string   `json:"encryptedApiKey"`
	APIFormat       string   `json:"apiFormat"`
	Models          []string `json:"models"`
	SelectedModel   string   `json:"selectedModel"`
	IsActive        *bool    `json:"isActive"`
}

// UserModelProviderPatchInput represents parameters to patch a model provider.
type UserModelProviderPatchInput struct {
	UserID        string  `json:"userId"`
	ProviderKey   string  `json:"providerKey"`
	SelectedModel *string `json:"selectedModel"`
	MakeActive    *bool   `json:"makeActive"`
}

// UserModelProviderDeleteInput represents parameters to delete a model provider.
type UserModelProviderDeleteInput struct {
	UserID      string `json:"userId"`
	ProviderKey string `json:"providerKey"`
}

func maskApiKey(key string) string {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return ""
	}
	if len(trimmed) <= 8 {
		return "••••••••"
	}
	return trimmed[:5] + "••••••••••••" + trimmed[len(trimmed)-4:]
}

func sanitizeUserModelProvider(rec *UserModelProviderRecord) *UserModelProviderView {
	if rec == nil {
		return nil
	}
	models := rec.Models
	if models == nil {
		models = []string{}
	}
	return &UserModelProviderView{
		ID:            rec.ID,
		ProviderKey:   rec.ProviderKey,
		Name:          rec.Name,
		BaseURL:       rec.BaseURL,
		MaskedApiKey:  maskApiKey(rec.APIKey),
		HasApiKey:     len(strings.TrimSpace(rec.APIKey)) > 0,
		APIFormat:     rec.APIFormat,
		Models:        models,
		SelectedModel: rec.SelectedModel,
		IsActive:      rec.IsActive,
		HealthStatus:  rec.HealthStatus,
		LatencyMs:     rec.LatencyMs,
		LastError:     rec.LastError,
		LastTestedAt:  rec.LastTestedAt,
		CreatedAt:     rec.CreatedAt,
		UpdatedAt:     rec.UpdatedAt,
	}
}

func toUserModelProviderRecord(m db.UserModelProvider) UserModelProviderRecord {
	var latencyMs *int
	if m.LatencyMs.Valid {
		v := int(m.LatencyMs.Int32)
		latencyMs = &v
	}
	var lastError *string
	if m.LastError.Valid {
		s := m.LastError.String
		lastError = &s
	}
	var lastTestedAt *string
	if m.LastTestedAt.Valid {
		s := m.LastTestedAt.Time.UTC().Format(time.RFC3339)
		lastTestedAt = &s
	}
	createdAt := ""
	if m.CreatedAt.Valid {
		createdAt = m.CreatedAt.Time.UTC().Format(time.RFC3339)
	}
	updatedAt := ""
	if m.UpdatedAt.Valid {
		updatedAt = m.UpdatedAt.Time.UTC().Format(time.RFC3339)
	}
	models := m.Models
	if models == nil {
		models = []string{}
	}
	return UserModelProviderRecord{
		ID:            m.ID,
		UserID:        m.UserId,
		ProviderKey:   m.ProviderKey,
		Name:          m.Name,
		BaseURL:       m.BaseUrl,
		APIKey:        m.ApiKey,
		APIFormat:     m.ApiFormat,
		Models:        models,
		SelectedModel: m.SelectedModel,
		IsActive:      m.IsActive,
		HealthStatus:  m.HealthStatus,
		LatencyMs:     latencyMs,
		LastError:     lastError,
		LastTestedAt:  lastTestedAt,
		CreatedAt:     createdAt,
		UpdatedAt:     updatedAt,
	}
}

// ListUserModelProviders retrieves all configured model providers for a user.
func (s *PgxStore) ListUserModelProviders(ctx context.Context, userID string) ([]UserModelProviderView, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}
	if userID == "" {
		return nil, errors.New("userId cannot be empty")
	}

	q := s.getQueries()
	rows, err := q.ListUserModelProvidersByUserID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list user model providers: %w", err)
	}

	result := make([]UserModelProviderView, 0, len(rows))
	for _, row := range rows {
		rec := toUserModelProviderRecord(row)
		v := sanitizeUserModelProvider(&rec)
		result = append(result, *v)
	}

	return result, nil
}

// UpsertUserModelProvider creates or updates a model provider with mutual exclusion for active status.
func (s *PgxStore) UpsertUserModelProvider(ctx context.Context, input UserModelProviderUpsertInput) (*UserModelProviderView, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}
	if input.UserID == "" {
		return nil, errors.New("userId cannot be empty")
	}
	if input.ProviderKey == "" {
		return nil, errors.New("providerKey cannot be empty")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	qtx := s.getQueries().WithTx(tx)

	// 1. Check existing row
	existingID, err := qtx.GetUserModelProviderIDByKey(ctx, db.GetUserModelProviderIDByKeyParams{
		UserId:      input.UserID,
		ProviderKey: input.ProviderKey,
	})
	isExisting := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("failed to check existing provider: %w", err)
	}

	trimmedKey := strings.TrimSpace(input.EncryptedApiKey)
	if !isExisting && trimmedKey == "" {
		return nil, ErrApiKeyRequired
	}

	// 2. Count existing records for this user
	existingCount, err := qtx.CountUserModelProvidersByUserID(ctx, input.UserID)
	if err != nil {
		return nil, fmt.Errorf("failed to count existing user model providers: %w", err)
	}

	shouldBeActive := (input.IsActive != nil && *input.IsActive) || existingCount == 0

	apiFormat := input.APIFormat
	if apiFormat == "" {
		apiFormat = "openai"
	}
	models := input.Models
	if models == nil {
		models = []string{}
	}

	var row db.UserModelProvider
	if isExisting {
		row, err = qtx.UpdateUserModelProvider(ctx, db.UpdateUserModelProviderParams{
			Name:          input.Name,
			BaseUrl:       input.BaseURL,
			ApiKey:        trimmedKey,
			ApiFormat:     apiFormat,
			Models:        models,
			SelectedModel: input.SelectedModel,
			IsActive:      shouldBeActive,
			ID:            existingID,
			UserID:        input.UserID,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to update user model provider: %w", err)
		}

		if shouldBeActive {
			err = qtx.DeactivateOtherUserModelProviders(ctx, db.DeactivateOtherUserModelProvidersParams{
				UserId: input.UserID,
				ID:     existingID,
			})
			if err != nil {
				return nil, fmt.Errorf("failed to deactivate other providers: %w", err)
			}
		}
	} else {
		newID := uuid.NewString()
		if shouldBeActive {
			err = qtx.DeactivateAllUserModelProviders(ctx, input.UserID)
			if err != nil {
				return nil, fmt.Errorf("failed to deactivate existing providers: %w", err)
			}
		}

		row, err = qtx.InsertUserModelProvider(ctx, db.InsertUserModelProviderParams{
			ID:            newID,
			UserId:        input.UserID,
			ProviderKey:   input.ProviderKey,
			Name:          input.Name,
			BaseUrl:       input.BaseURL,
			ApiKey:        trimmedKey,
			ApiFormat:     apiFormat,
			Models:        models,
			SelectedModel: input.SelectedModel,
			IsActive:      shouldBeActive,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to insert user model provider: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit provider upsert: %w", err)
	}

	rec := toUserModelProviderRecord(row)
	return sanitizeUserModelProvider(&rec), nil
}

// PatchUserModelProvider updates active status or selected model for a provider.
func (s *PgxStore) PatchUserModelProvider(ctx context.Context, input UserModelProviderPatchInput) (*UserModelProviderView, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}
	if input.UserID == "" {
		return nil, errors.New("userId cannot be empty")
	}
	if input.ProviderKey == "" {
		return nil, errors.New("providerKey cannot be empty")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	qtx := s.getQueries().WithTx(tx)

	existingID, err := qtx.GetUserModelProviderIDByKey(ctx, db.GetUserModelProviderIDByKeyParams{
		UserId:      input.UserID,
		ProviderKey: input.ProviderKey,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrProviderNotFound
		}
		return nil, fmt.Errorf("failed to find provider: %w", err)
	}

	makeActive := input.MakeActive != nil && *input.MakeActive
	var row db.UserModelProvider

	if makeActive {
		err = qtx.DeactivateAllUserModelProviders(ctx, input.UserID)
		if err != nil {
			return nil, fmt.Errorf("failed to deactivate providers: %w", err)
		}

		selectedModelStr := ""
		if input.SelectedModel != nil {
			selectedModelStr = *input.SelectedModel
		}

		row, err = qtx.PatchUserModelProviderActiveAndModel(ctx, db.PatchUserModelProviderActiveAndModelParams{
			SelectedModel: selectedModelStr,
			ID:            existingID,
			UserID:        input.UserID,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to patch provider active state: %w", err)
		}
	} else if input.SelectedModel != nil && *input.SelectedModel != "" {
		row, err = qtx.PatchUserModelProviderSelectedModel(ctx, db.PatchUserModelProviderSelectedModelParams{
			ID:            existingID,
			UserId:        input.UserID,
			SelectedModel: *input.SelectedModel,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to patch provider selectedModel: %w", err)
		}
	} else {
		row, err = qtx.GetUserModelProviderByID(ctx, db.GetUserModelProviderByIDParams{
			ID:     existingID,
			UserId: input.UserID,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to get provider: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit provider patch: %w", err)
	}

	rec := toUserModelProviderRecord(row)
	return sanitizeUserModelProvider(&rec), nil
}

// DeleteUserModelProvider removes a provider and automatically promotes remaining first provider if active was removed.
func (s *PgxStore) DeleteUserModelProvider(ctx context.Context, input UserModelProviderDeleteInput) error {
	if s.pool == nil {
		return fmt.Errorf("database pool is not initialized")
	}
	if input.UserID == "" {
		return errors.New("userId cannot be empty")
	}
	if input.ProviderKey == "" {
		return errors.New("providerKey cannot be empty")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	qtx := s.getQueries().WithTx(tx)

	target, err := qtx.GetTargetProviderForDelete(ctx, db.GetTargetProviderForDeleteParams{
		UserId:      input.UserID,
		ProviderKey: input.ProviderKey,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // Idempotent deletion
		}
		return fmt.Errorf("failed to find target provider: %w", err)
	}

	err = qtx.DeleteUserModelProviderByID(ctx, db.DeleteUserModelProviderByIDParams{
		ID:     target.ID,
		UserId: input.UserID,
	})
	if err != nil {
		return fmt.Errorf("failed to delete provider: %w", err)
	}

	if target.IsActive {
		remainingID, err := qtx.GetRemainingFirstProviderID(ctx, input.UserID)
		if err == nil {
			err = qtx.SetUserModelProviderActiveByID(ctx, remainingID)
			if err != nil {
				return fmt.Errorf("failed to promote remaining provider to active: %w", err)
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("failed to check remaining providers: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit provider deletion: %w", err)
	}

	return nil
}

// GetActiveUserModelProvider returns the currently active model provider record for a user.
func (s *PgxStore) GetActiveUserModelProvider(ctx context.Context, userID string) (*UserModelProviderRecord, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}
	if userID == "" {
		return nil, errors.New("userId cannot be empty")
	}

	q := s.getQueries()
	row, err := q.GetActiveUserModelProvider(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get active provider: %w", err)
	}

	rec := toUserModelProviderRecord(row)
	return &rec, nil
}

// GetUserModelProviderCipher retrieves the raw stored ciphertext of an API key for a specific provider.
func (s *PgxStore) GetUserModelProviderCipher(ctx context.Context, userID, providerKey string) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool is not initialized")
	}
	if userID == "" {
		return "", errors.New("userId cannot be empty")
	}
	if providerKey == "" {
		return "", errors.New("providerKey cannot be empty")
	}

	q := s.getQueries()
	cipher, err := q.GetUserModelProviderCipher(ctx, db.GetUserModelProviderCipherParams{
		UserId:      userID,
		ProviderKey: providerKey,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrProviderNotFound
		}
		return "", fmt.Errorf("failed to get provider cipher: %w", err)
	}

	return cipher, nil
}
