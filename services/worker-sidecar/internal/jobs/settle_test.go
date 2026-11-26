package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBillingGoldenParity(t *testing.T) {
	candidates := []string{
		"testdata/billing.golden.json",
		"../../testdata/billing.golden.json",
		"services/worker-sidecar/testdata/billing.golden.json",
		"/src/services/worker-sidecar/testdata/billing.golden.json",
	}
	var raw []byte
	var err error
	for _, p := range candidates {
		if b, e := os.ReadFile(p); e == nil {
			raw = b
			err = nil
			break
		} else {
			err = e
		}
	}
	require.NoError(t, err, "billing.golden.json missing")

	var fixture struct {
		Cases []struct {
			Name     string              `json:"name"`
			Config   map[string]any      `json:"config"`
			Input    billingFixtureInput `json:"input"`
			Expected struct {
				EstimatedChunks int `json:"estimatedChunks"`
				BaseCredits     int `json:"baseCredits"`
				FinalCredits    int `json:"finalCredits"`
				RewardCredits   int `json:"rewardCredits"`
			} `json:"expected"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)

	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			cfg := dynamicCreditsConfig{creditsConfigDefaults}
			applyFixtureConfig(&cfg, tc.Config)
			chunks, base, final, reward := estimateRequiredCredits(
				tc.Input.TotalChars, tc.Input.DocCount, truthy(tc.Input.IsPublic), truthy(tc.Input.IsCodePedagogy), cfg)
			assert.Equal(t, tc.Expected.EstimatedChunks, chunks, "estimatedChunks")
			assert.Equal(t, tc.Expected.BaseCredits, base, "baseCredits")
			assert.Equal(t, tc.Expected.FinalCredits, final, "finalCredits")
			assert.Equal(t, tc.Expected.RewardCredits, reward, "rewardCredits")
		})
	}
}

type billingFixtureInput struct {
	TotalChars     int   `json:"totalChars"`
	DocCount       int   `json:"docCount"`
	IsPublic       *bool `json:"isPublic"`
	IsCodePedagogy *bool `json:"isCodePedagogy"`
}

func truthy(b *bool) bool { return b != nil && *b }

func applyFixtureConfig(cfg *dynamicCreditsConfig, m map[string]any) {
	if v, ok := m["standardChunkCharSize"].(float64); ok {
		cfg.standardChunkCharSize = int(v)
	}
	if v, ok := m["codePedagogyMultiplier"].(float64); ok {
		cfg.codePedagogyMulti = v
	}
	if v, ok := m["maxCreditsPerImport"].(float64); ok {
		cfg.maxCreditsPerImport = int(v)
	}
}

func TestIsCodePedagogyBilling(t *testing.T) {
	tests := []struct {
		name          string
		teachingDepth string
		ingestMode    string
		want          bool
	}{
		{name: "深度教学", teachingDepth: "deep", want: true},
		{name: "概览不计", teachingDepth: "overview", want: false},
		{name: "code_only 模式", ingestMode: "code_only", want: true},
		{name: "双缺省", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, isCodePedagogyBilling(tt.teachingDepth, tt.ingestMode))
		})
	}
}

func TestResetWindowStart(t *testing.T) {
	tests := []struct {
		name        string
		at          string
		intervalHrs int
		wantUnixSec int64
	}{
		{name: "24h 对齐日内", at: "2026-09-12T03:30:00Z", intervalHrs: 24, wantUnixSec: 1789171200},
		{name: "非法间隔回落 24h", at: "2026-09-12T03:30:00Z", intervalHrs: 0, wantUnixSec: 1789171200},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			at, err := time.Parse(time.RFC3339, tt.at)
			require.NoError(t, err)
			got := resetWindowStart(at, tt.intervalHrs)
			assert.Equal(t, tt.wantUnixSec, got.Unix())
			assert.Equal(t, time.UTC, got.Location(), "window start must be UTC-located")
		})
	}

	t.Run("non-UTC input instant yields identical UTC window", func(t *testing.T) {
		utcTime, err := time.Parse(time.RFC3339, "2026-09-12T03:30:00Z")
		require.NoError(t, err)
		cst := utcTime.In(time.FixedZone("CST", 8*3600))
		assert.Equal(t, resetWindowStart(utcTime, 24), resetWindowStart(cst, 24),
			"window must depend only on the instant, never on the input zone")
	})
}

func TestSettleCreditBalanceBurn(t *testing.T) {
	tests := []struct {
		name          string
		actual        float64
		dailyLimit    float64
		used          float64
		frozen        float64
		creditBalance float64
		wantBurn      float64
	}{
		{
			name:          "1.17.4.4 within daily quota requires zero burn",
			actual:        100,
			dailyLimit:    300,
			used:          100,
			frozen:        0,
			creditBalance: 50,
			wantBurn:      0,
		},
		{
			name:          "1.17.4.4 overflow partially covered by balance",
			actual:        200,
			dailyLimit:    300,
			used:          400,
			frozen:        0,
			creditBalance: 60,
			wantBurn:      60,
		},
		{
			name:          "1.17.4.4 overflow fully covered by balance",
			actual:        200,
			dailyLimit:    300,
			used:          400,
			frozen:        0,
			creditBalance: 150,
			wantBurn:      100,
		},
		{
			name:          "1.17.4.4 zero or negative credit balance results in zero burn",
			actual:        200,
			dailyLimit:    300,
			used:          400,
			frozen:        0,
			creditBalance: 0,
			wantBurn:      0,
		},
		{
			name:          "1.17.4.4 negative headroom clamped to zero",
			actual:        200,
			dailyLimit:    300,
			used:          600,
			frozen:        50,
			creditBalance: 300,
			wantBurn:      200,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := calculateCreditBalanceBurn(tt.actual, tt.dailyLimit, tt.used, tt.frozen, tt.creditBalance)
			assert.Equal(t, tt.wantBurn, got)
		})
	}

	t.Run("1.17.4.4 conditional deduction SQL prevents concurrent negative balance", func(t *testing.T) {
		const expectedClause = `UPDATE "User" SET "creditBalance" = "creditBalance" - $1`
		const expectedWhere = `WHERE id = $2 AND "creditBalance" >= $1`
		assert.Contains(t, creditBalanceBurnSQL, expectedClause)
		assert.Contains(t, creditBalanceBurnSQL, expectedWhere)
	})
}

func TestTierLimitsAndRoles(t *testing.T) {
	tests := []struct {
		name      string
		tier      string
		wantMax   int
		wantDaily int
	}{
		{name: "1.17.4.4 FREE tier limits", tier: "FREE", wantMax: 300, wantDaily: 1000},
		{name: "1.17.4.4 PRO tier limits", tier: "PRO", wantMax: 600, wantDaily: 3000},
		{name: "1.17.4.4 ENTERPRISE tier limits", tier: "ENTERPRISE", wantMax: 0, wantDaily: 0},
		{name: "1.17.4.4 unknown tier fallback", tier: "unknown-tier", wantMax: 300, wantDaily: 1000},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			limits := tierLimitsOf(tt.tier)
			assert.Equal(t, tt.wantMax, limits.maxImportCreditsPerJob)
			assert.Equal(t, tt.wantDaily, limits.dailyImportCredits)
		})
	}

	roleTests := []struct {
		role    string
		isAdmin bool
	}{
		{"ADMIN", true},
		{"SUPER_ADMIN", true},
		{"USER", false},
		{"ANONYMOUS", false},
	}
	for _, tt := range roleTests {
		t.Run("1.17.4.4 role_"+tt.role, func(t *testing.T) {
			assert.Equal(t, tt.isAdmin, isAdminRole(tt.role))
		})
	}
}

func TestNullIfEmpty(t *testing.T) {
	assert.Nil(t, nullIfEmpty(""))
	assert.Nil(t, nullIfEmpty("  "))
	assert.Equal(t, "rid-1", nullIfEmpty("rid-1"))
}

type settlementFake struct {
	t        *testing.T
	statuses map[string]string
	results  map[string]map[string]any
	writes   int
}

func newSettlementFake(t *testing.T) *settlementFake {
	t.Helper()
	return &settlementFake{t: t, statuses: map[string]string{}, results: map[string]map[string]any{}}
}

func (f *settlementFake) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	switch sql {
	case markImportRewardPendingSQL:
		f.results[args[0].(string)]["importRewardPending"] = true
	case clearImportRewardPendingSQL:
		f.results[args[0].(string)]["importRewardPending"] = false
	default:
		f.t.Fatalf("unexpected sql: %s", sql)
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

type statusRow string

func (r statusRow) Scan(dest ...any) error { *dest[0].(*string) = string(r); return nil }

func (f *settlementFake) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	assert.Equal(f.t, `SELECT status FROM "ImportJob" WHERE id = $1`, sql)
	return statusRow(f.statuses[args[0].(string)])
}

type rewardFake struct {
	calls []string
	err   error
}

func (f *rewardFake) GrantImportReward(_ context.Context, id string) error {
	f.calls = append(f.calls, id)
	return f.err
}

func TestRetryImportReward(t *testing.T) {
	tests := []struct {
		name, status string
		fail         bool
		calls        int
	}{
		{"completed reentry", "COMPLETED", false, 1},
		{"callback failure leaves pending", "COMPLETED", true, 1},
		{"failed never awards", "FAILED", false, 0},
		{"queued never awards", "QUEUED", false, 0},
		{"running never awards", "RUNNING", false, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := newSettlementFake(t)
			db.statuses[tt.name] = tt.status
			db.results[tt.name] = map[string]any{"importRewardPending": false}
			api := &rewardFake{}
			if tt.fail {
				api.err = errors.New("callback offline")
			}
			err := retryImportReward(context.Background(), db, api, tt.name)
			if tt.fail {
				require.Error(t, err)
				assert.Equal(t, true, db.results[tt.name]["importRewardPending"])
			} else {
				require.NoError(t, err)
				if tt.calls > 0 {
					assert.Equal(t, false, db.results[tt.name]["importRewardPending"])
				}
			}
			assert.Len(t, api.calls, tt.calls)
		})
	}
}

func TestSettleTransactionInvariants(t *testing.T) {
	srcBytes, err := os.ReadFile("settle.go")
	require.NoError(t, err)
	src := string(srcBytes)

	var codeOnly strings.Builder
	for _, line := range strings.Split(src, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") {
			continue
		}
		if idx := strings.Index(line, " // "); idx >= 0 {
			line = line[:idx]
		}
		codeOnly.WriteString(line + "\n")
	}
	code := codeOnly.String()

	t.Run("cap aggregation must never touch the global pool", func(t *testing.T) {
		start := strings.Index(code, "func (s *PgxStore) capDailyTranscriptionRewardTx")
		require.GreaterOrEqual(t, start, 0, "capDailyTranscriptionRewardTx must exist")
		end := start
		for i := start; i < len(code); i++ {
			if code[i] == '}' {
				end = i
				break
			}
		}
		body := code[start:end]
		assert.NotContains(t, body, "s.pool.",
			"封顶聚合在 tx pgx.Tx 作用域内，穿透全局池=池满饥饿死锁（GO-006 同源锚点）")
	})

	t.Run("reward row lock is a single atomic statement", func(t *testing.T) {
		sqlBytes, err := os.ReadFile("../../queries/jobs.sql")
		require.NoError(t, err)
		sqlSrc := string(sqlBytes)
		assert.Contains(t, sqlSrc, `SELECT tier, role FROM "User" WHERE id = $1 FOR UPDATE`,
			"行锁与读取须合并为单条 FOR UPDATE（原两步多一次网络往返）")
		assert.NotContains(t, sqlSrc, `SELECT id FROM "User" WHERE id = $1 FOR UPDATE`,
			"孤立 SELECT id FOR UPDATE 两步加锁形态禁止回归")
	})
}

func TestSettleSavedRepoBypassInvariants(t *testing.T) {
	src, err := os.ReadFile("settle.go")
	require.NoError(t, err)
	s := string(src)
	assert.Contains(t, s, `shelfUserId != "system-batch-transcriber"`,
		"系统批量转录服务账号禁止自动写入 SavedRepo")
	assert.Contains(t, s, `!skipBookmark`,
		"指定 skipBookmark 时禁止自动写入 SavedRepo")
}

func TestNotificationConvergenceInvariants(t *testing.T) {
	sqlBytes, err := os.ReadFile("../../queries/jobs.sql")
	if err != nil {
		sqlBytes, err = os.ReadFile("queries/jobs.sql")
	}
	require.NoError(t, err)
	sqlContent := string(sqlBytes)

	assert.Contains(t, sqlContent, "'tutorial_published'",
		"InsertNotificationPublishGift 必须将通知类型统一收敛为 tutorial_published")
	assert.NotContains(t, sqlContent, "'publish_gift'",
		"站内通知表禁止再写入已退役的 publish_gift 类型（统一收敛为 tutorial_published）")

	srcBytes, err := os.ReadFile("settle.go")
	require.NoError(t, err)
	src := string(srcBytes)
	assert.Contains(t, src, "教程已公开上线，导入消耗的 %d 积分已全额返还",
		"grantPublishGift 的通知文案必须与公开上线闭环对齐")
}

func TestDailyEarnCapRatioDefault(t *testing.T) {
	t.Setenv("UPDATE_EARN_CAP_RATIO", "")
	os.Unsetenv("UPDATE_EARN_CAP_RATIO")
	assert.Equal(t, float64(1), dailyEarnCapRatio(), "未设置必须默认 1（对齐 Node ?? 1）")

	t.Setenv("UPDATE_EARN_CAP_RATIO", "abc")
	assert.Equal(t, float64(1), dailyEarnCapRatio(), "非法值必须默认 1")

	t.Setenv("UPDATE_EARN_CAP_RATIO", "0.5")
	assert.Equal(t, 0.5, dailyEarnCapRatio())

	t.Setenv("UPDATE_EARN_CAP_RATIO", "-2")
	assert.Equal(t, float64(0), dailyEarnCapRatio(), "负值钳 0")
}
