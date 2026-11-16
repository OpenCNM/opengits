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

// ─────────────────────────────────────────────────────────────
// 预算首帧闸（Frame-1 Fail-Fast，2026-10）。
//
// 转录执行体此前要烧到 LLM 调用才被网关以 BUDGET_EXCEEDED 拒绝——每轮
// 5s 空转全套 prepare+CAS。本闸在 Coordinate 阶段 0（prepare 之前）就地
// 判定，预算不足直接 BodyDeferred。
//
// SSOT 边界（346：规则的数字是数据，只有比较器是代码）：
// - 阈值数字的单一事实源 = "PlatformBudgetConfig" 单行表（admin 热调）；
// - 比较器（判定序/当日窗口/BYOK 豁免/source 分桶）镜像 apps/client/src/
//   lib/llm-budget.ts checkLlmBudget，语义逐字对齐并由 budget_test.go
//   表驱动锁定——两侧任何判定序变更须同步（注释互链）；
// - 网关调用时检查保持不动作为权威闸：本预检只提前拦、绝不放行网关会拒
//   的调用（方向单调，非逃逸双轨）；预检自身故障时放行交权威闸兜底。
// ─────────────────────────────────────────────────────────────

// transcriptionBudgetSource 转录 purposes 的记账 source 标签（对齐 web
// llm-gateway/registry.ts 各转录 purpose 的 source: 'transcription'）。
const transcriptionBudgetSource = "transcription"

// 无配置行时的缺省阈值 = Prisma schema PlatformBudgetConfig 列默认值
// （TS 侧 getBudgetConfig 无行时自动建默认行，读侧语义等价）。
const (
	defaultPerUserDailyTokens  = int64(200000)
	defaultPlatformDailyTokens = int64(5000000)
)

// budgetThresholds 预算阈值快照（数字全部来自配置表单行）。
type budgetThresholds struct {
	PerUserDaily  int64
	PlatformDaily int64
	BreakerOn     bool
	SourceQuotas  map[string]int64
}

// normalizeSourceQuotas 镜像 TS normalizeSourceQuotas：非字符串键/负值/
// 非有限数一律丢弃（脏数据容错，两侧同款防御）。
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

// evaluateBudget 纯比较器（表驱动单测锚点）：判定序与阈值语义（>= 含等）
// 逐字镜像 checkLlmBudget——user 桶 → platform 全局 → source 分桶。
// 返回 nil=放行；非 nil=BUDGET_EXCEEDED（scope 入 Message，供观测）。
func evaluateBudget(t budgetThresholds, userSpent, platformSpent, sourceSpent int64, source string) error {
	if !t.BreakerOn {
		return nil
	}
	if t.PlatformDaily <= 0 && t.PerUserDaily <= 0 && len(t.SourceQuotas) == 0 {
		return nil // 全不设限
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

// BudgetProbeStore 预算首帧探测能力（可选注入面：单测 fake 不实现即跳过，
// 与 LlmEdgesStore 同款可选能力模式）。
type BudgetProbeStore interface {
	// CheckLlmBudget 判定该用户今日转录是否尚有平台预算：
	// BYOK（激活自有服务商）豁免；返回 *LlmGatewayError{BUDGET_EXCEEDED} 表
	// 示应 BodyDeferred（errpolicy ClassBudget 既有语义零改动）。
	CheckLlmBudget(ctx context.Context, userId string) error
}

// dayStartLocal 当日零点（进程本地时区）。调用方必须 .UTC() 后传给 pgtype.Timestamp，
// 与 Prisma 写入的 Naive UTC 对齐。
func dayStartLocal() time.Time {
	now := time.Now()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
}

// CheckLlmBudget PgxStore 实现：BYOK 豁免查询 + 阈值快照 + 当日聚合。
// 拒绝决策不缓存（镜像 TS：阈值热调后即时恢复）。
func (s *PgxStore) CheckLlmBudget(ctx context.Context, userId string) error {
	if s == nil || s.pool == nil {
		return nil // 能力不可用即放行，权威闸在网关
	}
	// BYOK 豁免：用户激活自有服务商 → 烧用户 key（keyOrigin=user 不计预算）。
	// 与 prepare 的模型解析共用同一查询（LoadActiveUserModelId）。
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
		// 配置读取故障：放行交网关权威闸（预检不构成新故障点）
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
	// 分桶只在本通道配置了配额时才需要聚合（镜像 TS 的短路语义）
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
