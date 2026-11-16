package transcription

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 🧪 预算首帧闸比较器（Frame-1 Fail-Fast）：判定序与阈值语义（>= 含等）
// 逐字镜像 apps/client/src/lib/llm-budget.ts checkLlmBudget——user 桶 →
// platform 全局 → source 分桶；任何判定序/边界变更两侧须同步。
func TestEvaluateBudget(t *testing.T) {
	tests := []struct {
		name          string
		thresholds    budgetThresholds
		userSpent     int64
		platformSpent int64
		sourceSpent   int64
		wantAllowed   bool
		wantScope     string
	}{
		{
			name:        "breaker 关闭全放行",
			thresholds:  budgetThresholds{PerUserDaily: 100, PlatformDaily: 100, BreakerOn: false, SourceQuotas: map[string]int64{}},
			userSpent:   99999,
			wantAllowed: true,
		},
		{
			name:          "全不设限放行（阈值全零无分桶）",
			thresholds:    budgetThresholds{BreakerOn: true, SourceQuotas: map[string]int64{}},
			platformSpent: 99999,
			wantAllowed:   true,
		},
		{
			name:          "用户日限额命中（>= 含等，与 TS 同边界）",
			thresholds:    budgetThresholds{PerUserDaily: 1000, PlatformDaily: 5000, BreakerOn: true, SourceQuotas: map[string]int64{}},
			userSpent:     1000,
			platformSpent: 2000,
			wantAllowed:   false,
			wantScope:     "user",
		},
		{
			name:          "用户限额内放行",
			thresholds:    budgetThresholds{PerUserDaily: 1000, PlatformDaily: 5000, BreakerOn: true, SourceQuotas: map[string]int64{}},
			userSpent:     999,
			platformSpent: 4999,
			wantAllowed:   true,
		},
		{
			name:          "平台日限额命中",
			thresholds:    budgetThresholds{PerUserDaily: 1000, PlatformDaily: 5000, BreakerOn: true, SourceQuotas: map[string]int64{}},
			userSpent:     100,
			platformSpent: 5000,
			wantAllowed:   false,
			wantScope:     "platform",
		},
		{
			name:          "用户桶优先于平台桶（判定序镜像 TS）",
			thresholds:    budgetThresholds{PerUserDaily: 100, PlatformDaily: 200, BreakerOn: true, SourceQuotas: map[string]int64{}},
			userSpent:     150,
			platformSpent: 250,
			wantAllowed:   false,
			wantScope:     "user",
		},
		{
			name:          "转录通道分桶命中",
			thresholds:    budgetThresholds{PerUserDaily: 1000, PlatformDaily: 5000, BreakerOn: true, SourceQuotas: map[string]int64{transcriptionBudgetSource: 300}},
			userSpent:     10,
			platformSpent: 400,
			sourceSpent:   300,
			wantAllowed:   false,
			wantScope:     "source:" + transcriptionBudgetSource,
		},
		{
			name:          "未配桶通道不受分桶约束（缺省桶=仅全局约束）",
			thresholds:    budgetThresholds{PerUserDaily: 1000, PlatformDaily: 5000, BreakerOn: true, SourceQuotas: map[string]int64{"publish_review": 300}},
			userSpent:     10,
			platformSpent: 400,
			sourceSpent:   99999,
			wantAllowed:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := evaluateBudget(tt.thresholds, tt.userSpent, tt.platformSpent, tt.sourceSpent, transcriptionBudgetSource)
			if tt.wantAllowed {
				assert.NoError(t, err)
				return
			}
			require.Error(t, err)
			var gw *client.LlmGatewayError
			require.True(t, errors.As(err, &gw), "must classify as gateway budget error for errpolicy")
			assert.True(t, gw.IsBudgetExceeded())
			assert.Contains(t, gw.Message, tt.wantScope)
			assert.True(t, isBudgetErr(err), "errpolicy must map to ClassBudget (BodyDeferred)")
		})
	}
}

// 🧪 sourceQuotas 脏数据防御：非数字/负值/NaN/危险键一律丢弃（镜像 TS
// normalizeSourceQuotas），合法条目保留。
func TestNormalizeSourceQuotas(t *testing.T) {
	out := normalizeSourceQuotas([]byte(`{"transcription":300,"bad_negative":-1,"bad_string":"x","__proto__":5,"ok_zero":0}`))
	assert.Equal(t, map[string]int64{"transcription": 300, "ok_zero": 0}, out)
	assert.Empty(t, normalizeSourceQuotas([]byte(`not json`)))
	assert.Empty(t, normalizeSourceQuotas(nil))
}

// 🧪 Frame-1 集成：预算耗尽时第一帧即 BodyDeferred——prepare 不执行、
// 锁不抢、文档状态零触碰（消除"全套备料后才被网关拒绝"的每轮空转）。
func TestBodyBudgetPrecheckDefersBeforePrepare(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# raw", strPtr("中文"), true), valid: true}
	llm := &fakeLlm{text: "# 译文"}
	st := &fakeBodyStore{cas: true, budgetErr: &LlmGatewayError{Code: "BUDGET_EXCEEDED", Status: 429}}
	prepareCalls := 0
	deps := TranscriptionBodyDeps{
		Web:   web,
		Llm:   llm,
		Store: st,
		PrepareFunc: func(ctx context.Context, docId, userId string, opts doc.PrepareOptions) (*doc.PrepareResult, error) {
			prepareCalls++
			return web.Prepare(ctx, docId, userId, opts)
		},
		FinalizeStore: &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"},
	}

	out, errMsg := runTranscriptionBody(context.Background(), loadConfigFromEnv(), deps, "j1", "d1", "u1")

	assert.Equal(t, bodyDeferred, out, "budget precheck must defer at frame 1")
	assert.Equal(t, "", errMsg)
	assert.Zero(t, prepareCalls, "prepare must NOT run when budget is exhausted")
	assert.Empty(t, st.cleared, "document status must not be touched")
	assert.Empty(t, st.saved, "no checkpoint side effects")
}

// 🧪 进程本地零点与 Naive UTC 对齐：dayStartLocal().UTC() 的 Hour/Minute/Second 均为零（相对本地时区），
// 且其 UTC 时间能消除 PostgreSQL timestamp without time zone 的 8 小时统计盲区。
func TestDayStartLocalAlignment(t *testing.T) {
	tests := []struct {
		name        string
		localDate   time.Time
		wantUtcHour int
		wantUtcDay  int
	}{
		{
			name:        "UTC 零时区零点对齐",
			localDate:   time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC),
			wantUtcHour: 0,
			wantUtcDay:  3,
		},
		{
			name:        "CST (UTC+8) 消除 8 小时统计盲区（前一天 16:00 UTC）",
			localDate:   time.Date(2026, 10, 3, 0, 0, 0, 0, time.FixedZone("CST", 8*3600)),
			wantUtcHour: 16,
			wantUtcDay:  2,
		},
		{
			name:        "EST (UTC-5) 本地零点映射到 UTC 05:00",
			localDate:   time.Date(2026, 10, 3, 0, 0, 0, 0, time.FixedZone("EST", -5*3600)),
			wantUtcHour: 5,
			wantUtcDay:  3,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			utc := tt.localDate.UTC()
			assert.Equal(t, tt.wantUtcHour, utc.Hour())
			assert.Equal(t, tt.wantUtcDay, utc.Day())
			// 物理事实：无论是哪个时区，转为 UTC 时间戳后与原时间代表同一绝对瞬间
			assert.True(t, tt.localDate.Equal(utc))
		})
	}

	t.Run("当前系统进程本地零点规格", func(t *testing.T) {
		start := dayStartLocal()
		assert.Equal(t, 0, start.Hour())
		assert.Equal(t, 0, start.Minute())
		assert.Equal(t, 0, start.Second())
		assert.Equal(t, 0, start.Nanosecond())
		assert.True(t, start.Equal(start.UTC()))
	})
}
