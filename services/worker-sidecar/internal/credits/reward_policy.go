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

// ─────────────────────────────────────────────────────────────
// 导入奖励防刷闸门（镜像 internal/jobs/settle.go 的
// capDailyTranscriptionRewardTx 家族；语义须与 jobs 侧同步演进——
// 原 Node 侧镜像 lib/credits/reward-cap.ts 已退役，本包为唯一实现。历史缺陷：回调发放路径
// GrantImportReward 曾完全绕过日封顶——与结算直发口径漂移，
// 已在此收敛为同款闸门）。
// ─────────────────────────────────────────────────────────────

// rewardPolicyConfig 封顶所需动态配置子集（PlatformCreditsConfig singleton
// 读，缺列/缺行回落默认——与 jobs.settleCreditsDefaults 语义一致）。
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

// tierDailyLimitRegistry 日获赠封顶基数（对齐 jobs.tierLimitsRegistry /
// lib/tier-limits.ts 的 dailyImportCredits 列；0 = 不限，走 defaultDailyCredits 兜底）。
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

// dailyEarnCapRatio 对齐 Node 历史默认值（TS 侧 updateMarket 配置键已退役，
// env UPDATE_EARN_CAP_RATIO 为 SSOT；未设置/非法默认 1、负值钳 0——与
// jobs.dailyEarnCapRatio 语义一致：默认 0 会把日封顶清零、整体吞掉奖励）。
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

// resetWindowStart 对齐 jobs.resetWindowStart（原 TS 侧 credits-ledger.ts
// getResetWindowBounds 已退役）：按间隔整除对齐，强制 UTC（CST 环境窗口漂移 8 小时）。
func resetWindowStart(now time.Time, intervalHours int) time.Time {
	safeHours := intervalHours
	if safeHours < 1 {
		safeHours = 24
	}
	interval := time.Duration(safeHours) * time.Hour
	startMs := now.UTC().UnixMilli() / interval.Milliseconds() * interval.Milliseconds()
	return time.UnixMilli(startMs).UTC()
}

// loadRewardPolicyConfig 读 singleton 行（任意失败回落默认，不阻断发放；
// 配置读属非临界区，走全局池与 jobs.loadCreditsConfig 同口径）。
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

// capDailyImportRewardTx 日获赠封顶（镜像 jobs.capDailyTranscriptionRewardTx：
// 三源合流聚合；聚合失败 fail-closed 按 +∞ 处理绝不盲发；事务持有中必须
// 走 tx 而非全局池——池满饥饿死锁，GO-006 同源约束）。
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
		chapterBase = math.Inf(1) // fail-closed：额度视为耗尽
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
		importAmount = math.Inf(1) // fail-closed：与 jobs 侧三源口径一致，绝不盲发
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
