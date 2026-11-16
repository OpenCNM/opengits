package userinteraction

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// ConversationSummary represents a summary of a user's conversation with AI.
type ConversationSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// ConversationMessageItem represents a single message in a conversation.
type ConversationMessageItem struct {
	ID              string `json:"id"`
	Role            string `json:"role"`
	Content         any    `json:"content"`
	ToolInvocations any    `json:"toolInvocations,omitempty"`
	CreatedAt       string `json:"createdAt"`
}

// ConversationRecord represents a complete conversation entity.
type ConversationRecord struct {
	ID           string `json:"id"`
	UserID       string `json:"userId"`
	RepositoryID string `json:"repositoryId"`
	Title        string `json:"title"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
}

// ConversationCreateInput represents input for creating a conversation.
type ConversationCreateInput struct {
	Owner        string `json:"owner,omitempty"`
	Repo         string `json:"repo,omitempty"`
	RepositoryID string `json:"repositoryId,omitempty"`
	UserID       string `json:"userId"`
	Title        string `json:"title,omitempty"`
}

// ConversationUpdateInput represents input for updating a conversation title.
type ConversationUpdateInput struct {
	ID     string `json:"id"`
	UserID string `json:"userId"`
	Title  string `json:"title"`
}

// ConversationDeleteInput represents input for deleting a conversation.
type ConversationDeleteInput struct {
	ID     string `json:"id"`
	UserID string `json:"userId"`
}

// ListConversations retrieves the conversation history of a user for a repository.
func (s *PgxStore) ListConversations(ctx context.Context, owner, repo, userID string) ([]ConversationSummary, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	repoRec, err := s.queries.ConvGetRepoByOwnerRepo(ctx, db.ConvGetRepoByOwnerRepoParams{
		Owner: owner,
		Repo:  repo,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrRepositoryNotFound
		}
		return nil, fmt.Errorf("failed to query repository for conversations: %w", err)
	}

	if !repoRec.IsPublic {
		_, err := s.queries.ConvCheckSavedRepo(ctx, db.ConvCheckSavedRepoParams{
			RepositoryId: repoRec.ID,
			UserId:       userID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrRepositoryForbidden
			}
			return nil, fmt.Errorf("failed to check repository access: %w", err)
		}
	}

	rows, err := s.queries.ConvListConversations(ctx, db.ConvListConversationsParams{
		UserId:       userID,
		RepositoryId: repoRec.ID,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to query conversations: %w", err)
	}

	items := make([]ConversationSummary, 0, len(rows))
	for _, r := range rows {
		items = append(items, ConversationSummary{
			ID:        r.ID,
			Title:     r.Title,
			CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339),
			UpdatedAt: r.UpdatedAt.Time.UTC().Format(time.RFC3339),
		})
	}

	return items, nil
}

// GetConversationMessages retrieves all messages for a conversation belonging to a user.
func (s *PgxStore) GetConversationMessages(ctx context.Context, conversationID, userID string) ([]ConversationMessageItem, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	_, err := s.queries.ConvCheckConversationOwner(ctx, db.ConvCheckConversationOwnerParams{
		ID:     conversationID,
		UserId: userID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrConversationNotFound
		}
		return nil, fmt.Errorf("failed to verify conversation ownership: %w", err)
	}

	rows, err := s.queries.ConvGetMessages(ctx, conversationID)
	if err != nil {
		return nil, fmt.Errorf("failed to query conversation messages: %w", err)
	}

	items := make([]ConversationMessageItem, 0, len(rows))
	for _, r := range rows {
		item := ConversationMessageItem{
			ID:        r.ID,
			Role:      r.Role,
			CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339),
		}

		if r.Role == "tool" {
			var parsedContent any
			if err := json.Unmarshal([]byte(r.Content), &parsedContent); err == nil {
				item.Content = parsedContent
			} else {
				item.Content = r.Content
			}
		} else {
			item.Content = r.Content
		}

		if len(r.ToolInvocations) > 0 && string(r.ToolInvocations) != "null" {
			var parsedInvocations any
			if err := json.Unmarshal(r.ToolInvocations, &parsedInvocations); err == nil {
				item.ToolInvocations = parsedInvocations
			}
		}

		items = append(items, item)
	}

	return items, nil
}

// CreateConversation creates a new conversation for a repository with access verification.
func (s *PgxStore) CreateConversation(ctx context.Context, input ConversationCreateInput) (*ConversationRecord, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}
	if input.UserID == "" {
		return nil, errors.New("userId cannot be empty")
	}

	repoID := input.RepositoryID
	if repoID == "" {
		if input.Owner == "" || input.Repo == "" {
			return nil, errors.New("repositoryId or (owner, repo) must be provided")
		}
		repoRec, err := s.queries.ConvGetRepoByOwnerRepo(ctx, db.ConvGetRepoByOwnerRepoParams{
			Owner: input.Owner,
			Repo:  input.Repo,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrRepositoryNotFound
			}
			return nil, fmt.Errorf("failed to query repository: %w", err)
		}
		repoID = repoRec.ID

		if !repoRec.IsPublic {
			_, err := s.queries.ConvCheckSavedRepo(ctx, db.ConvCheckSavedRepoParams{
				RepositoryId: repoID,
				UserId:       input.UserID,
			})
			if err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, ErrRepositoryForbidden
				}
				return nil, fmt.Errorf("failed to check repository access: %w", err)
			}
		}
	} else {
		isPublic, err := s.queries.ConvGetRepoIsPublic(ctx, repoID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrRepositoryNotFound
			}
			return nil, fmt.Errorf("failed to query repository: %w", err)
		}

		if !isPublic {
			_, err := s.queries.ConvCheckSavedRepo(ctx, db.ConvCheckSavedRepoParams{
				RepositoryId: repoID,
				UserId:       input.UserID,
			})
			if err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, ErrRepositoryForbidden
				}
				return nil, fmt.Errorf("failed to check repository access: %w", err)
			}
		}
	}

	title := strings.TrimSpace(input.Title)
	if title == "" {
		title = "New Chat"
	}

	convID := uuid.NewString()
	r, err := s.queries.ConvCreateConversation(ctx, db.ConvCreateConversationParams{
		ID:           convID,
		UserId:       input.UserID,
		RepositoryId: repoID,
		Title:        title,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to insert conversation: %w", err)
	}

	return &ConversationRecord{
		ID:           r.ID,
		UserID:       r.UserId,
		RepositoryID: r.RepositoryId,
		Title:        r.Title,
		CreatedAt:    r.CreatedAt.Time.UTC().Format(time.RFC3339),
		UpdatedAt:    r.UpdatedAt.Time.UTC().Format(time.RFC3339),
	}, nil
}

// UpdateConversation updates a conversation's title with user ownership verification.
func (s *PgxStore) UpdateConversation(ctx context.Context, input ConversationUpdateInput) (*ConversationRecord, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}
	if input.ID == "" {
		return nil, errors.New("id cannot be empty")
	}
	if input.UserID == "" {
		return nil, errors.New("userId cannot be empty")
	}

	title := strings.TrimSpace(input.Title)
	if title == "" {
		return nil, errors.New("title cannot be empty")
	}

	r, err := s.queries.ConvUpdateConversationTitle(ctx, db.ConvUpdateConversationTitleParams{
		Title:  title,
		ID:     input.ID,
		UserId: input.UserID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrConversationNotFound
		}
		return nil, fmt.Errorf("failed to update conversation: %w", err)
	}

	return &ConversationRecord{
		ID:           r.ID,
		UserID:       r.UserId,
		RepositoryID: r.RepositoryId,
		Title:        r.Title,
		CreatedAt:    r.CreatedAt.Time.UTC().Format(time.RFC3339),
		UpdatedAt:    r.UpdatedAt.Time.UTC().Format(time.RFC3339),
	}, nil
}

// DeleteConversation deletes a conversation with ownership verification.
func (s *PgxStore) DeleteConversation(ctx context.Context, input ConversationDeleteInput) error {
	if s.pool == nil {
		return fmt.Errorf("database pool is not initialized")
	}
	if input.ID == "" {
		return errors.New("id cannot be empty")
	}
	if input.UserID == "" {
		return errors.New("userId cannot be empty")
	}

	affected, err := s.queries.ConvDeleteConversation(ctx, db.ConvDeleteConversationParams{
		ID:     input.ID,
		UserId: input.UserID,
	})
	if err != nil {
		return fmt.Errorf("failed to delete conversation: %w", err)
	}

	if affected == 0 {
		return ErrConversationNotFound
	}

	return nil
}
