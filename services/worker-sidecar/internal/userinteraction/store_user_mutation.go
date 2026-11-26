package userinteraction

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

func textToPtr(t pgtype.Text) *string {
	if t.Valid {
		s := t.String
		return &s
	}
	return nil
}

func timeToPtr(t pgtype.Timestamp) *time.Time {
	if t.Valid {
		tm := t.Time
		return &tm
	}
	return nil
}

type AuthCreateUserInput struct {
	ID        string  `json:"id,omitempty"`
	Name      *string `json:"name,omitempty"`
	Email     *string `json:"email,omitempty"`
	Image     *string `json:"image,omitempty"`
	GrantGift bool    `json:"grantGift,omitempty"`
}

type AuthUserResult struct {
	ID            string     `json:"id" db:"id"`
	Name          *string    `json:"name,omitempty" db:"name"`
	Email         *string    `json:"email,omitempty" db:"email"`
	Image         *string    `json:"image,omitempty" db:"image"`
	CreatedAt     time.Time  `json:"createdAt" db:"createdAt"`
	CreditBalance int        `json:"creditBalance" db:"creditBalance"`
	SignupGiftAt  *time.Time `json:"signupGiftAt,omitempty" db:"signupGiftAt"`
}

type UpdateUserInput struct {
	ID                 string  `json:"id"`
	UserID             string  `json:"userId,omitempty"`
	Name               *string `json:"name,omitempty"`
	Email              *string `json:"email,omitempty"`
	Image              *string `json:"image,omitempty"`
	IsBanned           *bool   `json:"isBanned,omitempty"`
	Tier               *string `json:"tier,omitempty"`
	Role               *string `json:"role,omitempty"`
	DailyMcpQuota      *int    `json:"dailyMcpQuota,omitempty"`
	McpRpmLimit        *int    `json:"mcpRpmLimit,omitempty"`
	SingleCallTokenCap *int    `json:"singleCallTokenCap,omitempty"`
}

type UserMutationResult struct {
	ID                 string  `json:"id" db:"id"`
	Name               *string `json:"name,omitempty" db:"name"`
	Email              *string `json:"email,omitempty" db:"email"`
	Image              *string `json:"image,omitempty" db:"image"`
	Role               string  `json:"role" db:"role"`
	IsBanned           bool    `json:"isBanned" db:"isBanned"`
	Tier               string  `json:"tier" db:"tier"`
	McpRpmLimit        int     `json:"mcpRpmLimit" db:"mcpRpmLimit"`
	DailyMcpQuota      int     `json:"dailyMcpQuota" db:"dailyMcpQuota"`
	SingleCallTokenCap int     `json:"singleCallTokenCap" db:"singleCallTokenCap"`
}

func (s *PgxStore) CreateUserAuth(ctx context.Context, input AuthCreateUserInput) (*AuthUserResult, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("database pool is not initialized")
	}

	id := strings.TrimSpace(input.ID)
	if id == "" {
		id = uuid.NewString()
	}

	creditBalance := int32(0)
	var signupGiftAt pgtype.Timestamp
	if input.GrantGift {
		creditBalance = 30
		signupGiftAt = pgtype.Timestamp{Time: time.Now(), Valid: true}
	}

	q := s.getQueries()

	var nameText, emailText, imageText pgtype.Text
	if input.Name != nil {
		nameText = pgtype.Text{String: *input.Name, Valid: true}
	}
	if input.Email != nil {
		emailText = pgtype.Text{String: *input.Email, Valid: true}
	}
	if input.Image != nil {
		imageText = pgtype.Text{String: *input.Image, Valid: true}
	}

	if input.Email != nil && strings.TrimSpace(*input.Email) != "" {
		row, err := q.CreateOrUpdateAuthUser(ctx, db.CreateOrUpdateAuthUserParams{
			ID:            id,
			Name:          nameText,
			Email:         emailText,
			Image:         imageText,
			CreditBalance: creditBalance,
			SignupGiftAt:  signupGiftAt,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to create or upsert auth user: %w", err)
		}
		return &AuthUserResult{
			ID:            row.ID,
			Name:          textToPtr(row.Name),
			Email:         textToPtr(row.Email),
			Image:         textToPtr(row.Image),
			CreatedAt:     row.CreatedAt.Time,
			CreditBalance: int(row.CreditBalance),
			SignupGiftAt:  timeToPtr(row.SignupGiftAt),
		}, nil
	}

	row, err := q.CreateAuthUserNoEmail(ctx, db.CreateAuthUserNoEmailParams{
		ID:            id,
		Name:          nameText,
		Email:         emailText,
		Image:         imageText,
		CreditBalance: creditBalance,
		SignupGiftAt:  signupGiftAt,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create auth user: %w", err)
	}
	return &AuthUserResult{
		ID:            row.ID,
		Name:          textToPtr(row.Name),
		Email:         textToPtr(row.Email),
		Image:         textToPtr(row.Image),
		CreatedAt:     row.CreatedAt.Time,
		CreditBalance: int(row.CreditBalance),
		SignupGiftAt:  timeToPtr(row.SignupGiftAt),
	}, nil
}

func (s *PgxStore) UpdateUser(ctx context.Context, input UpdateUserInput) (*UserMutationResult, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("database pool is not initialized")
	}
	id := strings.TrimSpace(input.ID)
	if id == "" {
		id = strings.TrimSpace(input.UserID)
	}
	if id == "" {
		return nil, errors.New("id is required")
	}

	setClauses := make([]string, 0, 10)
	args := []any{id}
	argIdx := 2

	if input.Name != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"name" = $%d`, argIdx))
		args = append(args, *input.Name)
		argIdx++
	}
	if input.Email != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"email" = $%d`, argIdx))
		args = append(args, *input.Email)
		argIdx++
	}
	if input.Image != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"image" = $%d`, argIdx))
		args = append(args, *input.Image)
		argIdx++
	}
	if input.IsBanned != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"isBanned" = $%d`, argIdx))
		args = append(args, *input.IsBanned)
		argIdx++
	}
	if input.Tier != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"tier" = $%d`, argIdx))
		args = append(args, *input.Tier)
		argIdx++
	}
	if input.Role != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"role" = $%d`, argIdx))
		args = append(args, *input.Role)
		argIdx++
	}
	if input.DailyMcpQuota != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"dailyMcpQuota" = $%d`, argIdx))
		args = append(args, *input.DailyMcpQuota)
		argIdx++
	}
	if input.McpRpmLimit != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"mcpRpmLimit" = $%d`, argIdx))
		args = append(args, *input.McpRpmLimit)
		argIdx++
	}
	if input.SingleCallTokenCap != nil {
		setClauses = append(setClauses, fmt.Sprintf(`"singleCallTokenCap" = $%d`, argIdx))
		args = append(args, *input.SingleCallTokenCap)
		argIdx++
	}

	if len(setClauses) == 0 {
		u, err := s.getQueries().GetUserMutationFieldsByID(ctx, id)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrUserNotFound
			}
			return nil, fmt.Errorf("failed to fetch user: %w", err)
		}
		return &UserMutationResult{
			ID:                 u.ID,
			Name:               textToPtr(u.Name),
			Email:              textToPtr(u.Email),
			Image:              textToPtr(u.Image),
			Role:               u.Role,
			IsBanned:           u.IsBanned,
			Tier:               u.Tier,
			McpRpmLimit:        int(u.McpRpmLimit),
			DailyMcpQuota:      int(u.DailyMcpQuota),
			SingleCallTokenCap: int(u.SingleCallTokenCap),
		}, nil
	}

	queryUpdate := fmt.Sprintf(`
		UPDATE "User"
		SET %s
		WHERE "id" = $1
		RETURNING "id", "name", "email", "image", "role", "isBanned", "tier", "mcpRpmLimit", "dailyMcpQuota", "singleCallTokenCap"`,
		strings.Join(setClauses, ", "))

	rows, err := s.pool.Query(ctx, queryUpdate, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to update user: %w", err)
	}
	defer rows.Close()

	res, err := pgx.CollectOneRow(rows, pgx.RowToStructByName[UserMutationResult])
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to update user: %w", err)
	}

	return &res, nil
}

func (s *PgxStore) DeleteUser(ctx context.Context, id string) error {
	if s == nil || s.pool == nil {
		return errors.New("database pool is not initialized")
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("id is required")
	}

	affected, err := s.getQueries().DeleteUserByID(ctx, id)
	if err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
	}
	if affected == 0 {
		return ErrUserNotFound
	}
	return nil
}
