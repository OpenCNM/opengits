package credits

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDailyEarnCapRatioDefault(t *testing.T) {
	tests := []struct {
		name string
		env  string
		set  bool
		want float64
	}{
		{name: "未设置 → 默认 1", set: false, want: 1},
		{name: "空串 → 默认 1", env: "", set: true, want: 1},
		{name: "非法值 → 默认 1", env: "abc", set: true, want: 1},
		{name: "0.5 → 0.5", env: "0.5", set: true, want: 0.5},
		{name: "负值 → 钳 0", env: "-2", set: true, want: 0},
		{name: "带空白 → 解析后 0.5", env: " 0.5 ", set: true, want: 0.5},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.set {
				t.Setenv("UPDATE_EARN_CAP_RATIO", tt.env)
			} else {
				t.Setenv("UPDATE_EARN_CAP_RATIO", "")
				os.Unsetenv("UPDATE_EARN_CAP_RATIO")
			}
			assert.Equal(t, tt.want, dailyEarnCapRatio())
		})
	}
}

func TestRewardPolicyResetWindowStart(t *testing.T) {
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
		assert.Equal(t, resetWindowStart(utcTime, 24), resetWindowStart(cst, 24))
	})
}

func TestTierDailyLimitOf(t *testing.T) {
	assert.Equal(t, 1000, tierDailyLimitOf("FREE"))
	assert.Equal(t, 3000, tierDailyLimitOf("PRO"))
	assert.Equal(t, 0, tierDailyLimitOf("ENTERPRISE"))
	assert.Equal(t, 1000, tierDailyLimitOf("UNKNOWN"), "未知 tier 回落 FREE")
}

func stripComments(t *testing.T, path string) string {
	t.Helper()
	srcBytes, err := os.ReadFile(path)
	require.NoError(t, err)
	var codeOnly strings.Builder
	for _, line := range strings.Split(string(srcBytes), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") {
			continue
		}
		if idx := strings.Index(line, " // "); idx >= 0 {
			line = line[:idx]
		}
		codeOnly.WriteString(line + "\n")
	}
	return codeOnly.String()
}

func TestGrantImportRewardCapInvariants(t *testing.T) {
	t.Run("cap aggregation must never touch the global pool", func(t *testing.T) {
		code := stripComments(t, "reward_policy.go")
		start := strings.Index(code, "func (s *PgxStore) capDailyImportRewardTx")
		require.GreaterOrEqual(t, start, 0, "capDailyImportRewardTx must exist")
		end := start
		depth := 0
		started := false
		for i := start; i < len(code); i++ {
			if code[i] == '{' {
				depth++
				started = true
			} else if code[i] == '}' {
				depth--
				if started && depth == 0 {
					end = i
					break
				}
			}
		}
		body := code[start:end]
		assert.NotContains(t, body, "s.pool.",
			"封顶聚合在 tx pgx.Tx 作用域内，穿透全局池=池满饥饿死锁（GO-006 同源锚点）")
	})

	t.Run("user row lock precedes balance increment", func(t *testing.T) {
		code := stripComments(t, "store.go")
		start := strings.Index(code, "func (s *PgxStore) GrantImportReward")
		require.GreaterOrEqual(t, start, 0, "GrantImportReward must exist")
		body := code[start:]
		lockIdx := strings.Index(body, "GetUserTierRoleForUpdate")
		capIdx := strings.Index(body, "capDailyImportRewardTx")
		incIdx := strings.Index(body, "IncrementUserBalance")
		require.GreaterOrEqual(t, lockIdx, 0, "用户行 FOR UPDATE 锁必须存在（advisory lock 仅按仓序列化，日封顶是用户级）")
		require.GreaterOrEqual(t, capIdx, 0, "日封顶调用必须存在")
		require.GreaterOrEqual(t, incIdx, 0)
		assert.Less(t, lockIdx, incIdx, "行锁必须先于余额入账")
		assert.Less(t, capIdx, incIdx, "封顶必须先于余额入账")
		assert.Contains(t, body, "int32(grantedAmount)",
			"入账/台账/仓累计必须使用封顶后的 grantedAmount，禁止回退 input.Amount")
	})
}
