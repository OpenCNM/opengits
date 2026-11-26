package credits

import (
	"context"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

type rewardPolicyConfig struct {
	defaultDailyCredits       int
	resetIntervalHours        int
	maxCreditsPerImport       int
	contributionVestingDays   int
	initialPublishRewardRatio float64
}

var rewardPolicyDefaults = rewardPolicyConfig{
	defaultDailyCredits:       1000,
	resetIntervalHours:        24,
	maxCreditsPerImport:       300,
	contributionVestingDays:   7,
	initialPublishRewardRatio: 0.0,
}

var tierDailyLimitRegistry = map[string]int{
	"FREE":       1000,
	"PRO":        3000,
	"ENTERPRISE": 0,
}

func tierDailyLimitOf(tier string) int {
	if v, ok := tierDailyLimitRegistry[tier]; ok {
		return v
	}
	return tierDailyLimitRegistry["FREE"]
}

func isAdminCreditRole(role string) bool {
	return role == "ADMIN" || role == "SUPER_ADMIN"
}

// Default to 1 rather than 0 when unset so missing env config does not zero out daily reward caps.
func dailyEarnCapRatio() float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv("UPDATE_EARN_CAP_RATIO")), 64)
	if err != nil {
		return 1
	}
	if v < 0 {
		return 0
	}
	return v
}

// Align window bounds in UTC to match Prisma timestamp(3) without time zone storage.
func resetWindowStart(now time.Time, intervalHours int) time.Time {
	safeHours := intervalHours
	if safeHours < 1 {
		safeHours = 24
	}
	interval := time.Duration(safeHours) * time.Hour
	startMs := now.UTC().UnixMilli() / interval.Milliseconds() * interval.Milliseconds()
	return time.UnixMilli(startMs).UTC()
}

// Config reads stay on the pool outside the grant tx and fall back to defaults on error.
func (s *PgxStore) loadRewardPolicyConfig(ctx context.Context) rewardPolicyConfig {
	cfg := rewardPolicyDefaults
	row, err := db.New(s.pool).LoadCreditsConfig(ctx)
	if err != nil {
		return cfg
	}
	if v := int(row.DefaultDailyCredits); v > 0 {
		cfg.defaultDailyCredits = v
	}
	if v := int(row.ResetIntervalHours); v > 0 {
		cfg.resetIntervalHours = v
	}
	if v := int(row.MaxCreditsPerImport); v > 0 {
		cfg.maxCreditsPerImport = v
	}
	if v := int(row.ContributionVestingDays); v > 0 {
		cfg.contributionVestingDays = v
	}
	if row.InitialPublishRewardRatio >= 0 && row.InitialPublishRewardRatio <= 1 {
		cfg.initialPublishRewardRatio = row.InitialPublishRewardRatio
	}
	return cfg
}

// Query via tx (never s.pool) to avoid pool starvation deadlock; fail closed to +Inf on errors.
func (s *PgxStore) capDailyImportRewardTx(ctx context.Context, tx pgx.Tx, userId string, amount int, tier string, cfg rewardPolicyConfig) (int, error) {
	if amount <= 0 {
		return 0, nil
	}
	start := resetWindowStart(time.Now().UTC(), cfg.resetIntervalHours)

	var chapterBase float64
	var err error
	chapterBase, err = db.New(tx).GetChapterBaseCreditsSince(ctx, db.GetChapterBaseCreditsSinceParams{
		ClaimedBy: pgtype.Text{String: userId, Valid: userId != ""},
		UpdatedAt: pgtype.Timestamp{Time: start, Valid: true},
	})
	if err != nil {
		chapterBase = math.Inf(1)
	}
	var ledgerAmount float64
	ledgerAmount, err = db.New(tx).GetLedgerAmountSince(ctx, db.GetLedgerAmountSinceParams{
		UserId:    userId,
		CreatedAt: pgtype.Timestamp{Time: start, Valid: true},
	})
	if err != nil {
		ledgerAmount = math.Inf(1)
	}
	importAmount := 0.0
	importAmount, err = db.New(tx).GetImportAmountSince(ctx, db.GetImportAmountSinceParams{
		UserId:    userId,
		UpdatedAt: pgtype.Timestamp{Time: start, Valid: true},
	})
	if err != nil {
		importAmount = math.Inf(1)
	}
	nonMarket := ledgerAmount
	if importAmount > nonMarket {
		nonMarket = importAmount
	}
	grantedToday := chapterBase + nonMarket

	dailyLimit := tierDailyLimitOf(tier)
	if dailyLimit == 0 {
		dailyLimit = cfg.defaultDailyCredits
	}
	cap := math.Floor(float64(dailyLimit) * dailyEarnCapRatio())
	allowance := cap - grantedToday
	if allowance < 0 {
		allowance = 0
	}
	if float64(amount) < allowance {
		allowance = float64(amount)
	}
	return int(allowance), nil
}
