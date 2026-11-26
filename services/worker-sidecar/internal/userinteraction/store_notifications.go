package userinteraction

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

type NotificationItem struct {
	ID        string          `json:"id"`
	UserID    string          `json:"userId"`
	Type      string          `json:"type"`
	Title     string          `json:"title"`
	Body      *string         `json:"body"`
	Payload   json.RawMessage `json:"payload"`
	ReadAt    *time.Time      `json:"readAt"`
	CreatedAt time.Time       `json:"createdAt"`
}

type NotificationListResult struct {
	Items       []NotificationItem `json:"items"`
	Total       int64              `json:"total"`
	UnreadCount int64              `json:"unreadCount"`
}

func (s *PgxStore) MarkNotificationsRead(ctx context.Context, userID string, ids []string, all bool) (int64, error) {
	if s == nil || s.pool == nil {
		return 0, fmt.Errorf("database pool is not initialized")
	}

	q := s.getQueries()
	now := pgtype.Timestamp{Time: time.Now(), Valid: true}

	if all {
		rows, err := q.MarkAllNotificationsRead(ctx, db.MarkAllNotificationsReadParams{
			ReadAt: now,
			UserId: userID,
		})
		if err != nil {
			return 0, fmt.Errorf("failed to update notifications readAt: %w", err)
		}
		return rows, nil
	}

	if len(ids) == 0 {
		return 0, nil
	}

	rows, err := q.MarkNotificationsReadByIDs(ctx, db.MarkNotificationsReadByIDsParams{
		ReadAt: now,
		UserID: userID,
		Ids:    ids,
	})
	if err != nil {
		return 0, fmt.Errorf("failed to update notifications readAt: %w", err)
	}
	return rows, nil
}

func (s *PgxStore) ListNotifications(ctx context.Context, userID string, page, pageSize int) (*NotificationListResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 15
	} else if pageSize > 100 {
		pageSize = 100
	}
	offset := (page - 1) * pageSize

	q := s.getQueries()
	dbItems, err := q.ListNotificationsByUserID(ctx, db.ListNotificationsByUserIDParams{
		UserID: userID,
		Limit:  int32(pageSize),
		Offset: int32(offset),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to query notifications: %w", err)
	}

	items := make([]NotificationItem, 0, len(dbItems))
	for _, it := range dbItems {
		var body *string
		if it.Body.Valid {
			s := it.Body.String
			body = &s
		}
		var readAt *time.Time
		if it.ReadAt.Valid {
			t := it.ReadAt.Time
			readAt = &t
		}
		items = append(items, NotificationItem{
			ID:        it.ID,
			UserID:    it.UserId,
			Type:      it.Type,
			Title:     it.Title,
			Body:      body,
			Payload:   it.Payload,
			ReadAt:    readAt,
			CreatedAt: it.CreatedAt.Time,
		})
	}

	counts, err := q.CountNotificationsByUserID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query notification counts: %w", err)
	}

	return &NotificationListResult{
		Items:       items,
		Total:       counts.Total,
		UnreadCount: counts.UnreadCount,
	}, nil
}

func (s *PgxStore) CreateNotifications(ctx context.Context, items []CreateNotificationInput) error {
	if s == nil || s.pool == nil {
		return fmt.Errorf("database pool is not initialized")
	}
	if len(items) == 0 {
		return nil
	}

	q := s.getQueries()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	qtx := q.WithTx(tx)
	for i, item := range items {
		if item.UserID == "" || item.Title == "" {
			continue
		}
		id := uuid.NewString()
		payload := item.Payload
		if len(payload) == 0 {
			payload = []byte("{}")
		}
		var body pgtype.Text
		if item.Body != nil {
			body = pgtype.Text{String: *item.Body, Valid: true}
		}
		err := qtx.CreateNotification(ctx, db.CreateNotificationParams{
			ID:      id,
			UserId:  item.UserID,
			Type:    item.Type,
			Title:   item.Title,
			Body:    body,
			Payload: payload,
		})
		if err != nil {
			return fmt.Errorf("failed to insert notification item %d: %w", i, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit notification creation: %w", err)
	}
	return nil
}

func (s *PgxStore) ClearNotifications(ctx context.Context, userID string) (int64, error) {
	if s == nil || s.pool == nil {
		return 0, fmt.Errorf("database pool is not initialized")
	}
	q := s.getQueries()
	return q.ClearAllNotificationsByUserID(ctx, userID)
}
