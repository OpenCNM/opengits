package transcription

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

const transcriptionBudgetSource = "transcription"

const (
	defaultPerUserDailyTokens  = int64(200000)
	defaultPlatformDailyTokens = int64(5000000)
)

type budgetThresholds struct {
	PerUserDaily  int64
	PlatformDaily int64
	BreakerOn     bool
	SourceQuotas  map[string]int64
}

func normalizeSourceQuotas(raw []byte) map[string]int64 {
	if len(raw) == 0 {
		return map[string]int64{}
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return map[string]int64{}
	}
	out := make(map[string]int64, len(parsed))
	for k, v := range parsed {
		if k == "" || len(k) > 128 || k == "__proto__" || k == "constructor" || k == "prototype" {
			continue
		}
		f, ok := v.(float64)
		if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
			continue
		}
		out[k] = int64(f)
	}
	return out
}

// Frame-1 monotonic preflight mirroring TS checkLlmBudget; preflight errors fail open to gateway check.
func evaluateBudget(t budgetThresholds, userSpent, platformSpent, sourceSpent int64, source string) error {
	if !t.BreakerOn {
		return nil
	}
	if t.PlatformDaily <= 0 && t.PerUserDaily <= 0 && len(t.SourceQuotas) == 0 {
		return nil
	}
	if t.PerUserDaily > 0 && userSpent >= t.PerUserDaily {
		return &client.LlmGatewayError{Code: client.ErrCodeBudgetExceeded, Status: 429, Message: "scope=user"}
	}
	if t.PlatformDaily > 0 && platformSpent >= t.PlatformDaily {
		return &client.LlmGatewayError{Code: client.ErrCodeBudgetExceeded, Status: 429, Message: "scope=platform"}
	}
	if quota, ok := t.SourceQuotas[source]; ok && sourceSpent >= quota {
		return &client.LlmGatewayError{Code: client.ErrCodeBudgetExceeded, Status: 429, Message: "scope=source:" + source}
	}
	return nil
}

type BudgetProbeStore interface {
	CheckLlmBudget(ctx context.Context, userId string) error
}

// Callers must convert to .UTC() before pgtype.Timestamp to match Prisma naive UTC columns.
func dayStartLocal() time.Time {
	now := time.Now()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
}

// Denials are never cached so admin budget updates take effect immediately.
func (s *PgxStore) CheckLlmBudget(ctx context.Context, userId string) error {
	if s == nil || s.pool == nil {
		return nil
	}
	if strings.TrimSpace(userId) != "" {
		model, err := s.queries.LoadActiveUserModelId(ctx, userId)
		if err == nil && strings.TrimSpace(model) != "" {
			return nil
		}
	}

	t := budgetThresholds{
		PerUserDaily:  defaultPerUserDailyTokens,
		PlatformDaily: defaultPlatformDailyTokens,
		BreakerOn:     true,
		SourceQuotas:  map[string]int64{},
	}
	if row, err := s.queries.GetPlatformBudgetConfigRow(ctx); err == nil {
		t.PerUserDaily = int64(row.PerUserDailyTokens)
		t.PlatformDaily = int64(row.PlatformDailyTokens)
		t.BreakerOn = row.BreakerEnabled
		t.SourceQuotas = normalizeSourceQuotas(row.SourceQuotas)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil
	}

	dayStart := dayStartLocal()
	userSpent, err := s.sumSpentSince(ctx, dayStart, userId, "")
	if err != nil {
		return nil
	}
	platformSpent, err := s.sumSpentSince(ctx, dayStart, "", "")
	if err != nil {
		return nil
	}
	sourceSpent := int64(0)
	if _, ok := t.SourceQuotas[transcriptionBudgetSource]; ok {
		sourceSpent, err = s.sumSpentSince(ctx, dayStart, "", transcriptionBudgetSource)
		if err != nil {
			return nil
		}
	}
	return evaluateBudget(t, userSpent, platformSpent, sourceSpent, transcriptionBudgetSource)
}

func (s *PgxStore) sumSpentSince(ctx context.Context, since time.Time, userId, source string) (int64, error) {
	return s.queries.SumPlatformTokensSince(ctx, db.SumPlatformTokensSinceParams{
		DayStart: pgtype.Timestamp{Time: since.UTC(), Valid: true},
		UserID:   userId,
		Source:   source,
	})
}
