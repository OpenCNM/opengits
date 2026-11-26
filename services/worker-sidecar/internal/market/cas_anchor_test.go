package market

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func sqlQueryBlock(t *testing.T, filename, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "queries", filename))
	require.NoError(t, err, "读取 %s 失败", filename)
	src := string(data)
	i := strings.Index(src, "-- name: "+name)
	require.GreaterOrEqualf(t, i, 0, "查询 %s 不存在于 %s", name, filename)
	block := src[i:]
	if j := strings.Index(block, "\n-- name: "); j >= 0 {
		block = block[:j]
	}
	return block
}

func TestMarketClaimJobCASAnchor(t *testing.T) {
	block := sqlQueryBlock(t, "market.sql", "MarketClaimJob")
	t.Run("认领守卫：仅 PENDING 且无有效租约可被认领", func(t *testing.T) {
		assert.Contains(t, block, `AND status = 'PENDING'`)
		assert.Contains(t, block, `("claimedUntil" IS NULL OR "claimedUntil" < now())`)
	})
	t.Run("租约写入：claimedUntil 按参数化 TTL 向后滑动", func(t *testing.T) {
		assert.Contains(t, block, `"claimedUntil" = now() + (sqlc.arg('ttlMinutes')::text || ' minutes')::interval`)
	})
	t.Run("认领即清零冻结积分（回池语义对偶）", func(t *testing.T) {
		assert.Contains(t, block, `"frozenCredits" = 0`)
	})
}

func TestMarketExtendClaimCASAnchor(t *testing.T) {
	block := sqlQueryBlock(t, "market.sql", "MarketExtendClaim")
	t.Run("三重守卫：本人 + CLAIMED + 租约未过期（过期租约不可复活）", func(t *testing.T) {
		assert.Contains(t, block, `AND status = 'CLAIMED'`)
		assert.Contains(t, block, `AND "claimedBy" = sqlc.arg('claimedBy')`)
		assert.Contains(t, block, `AND "claimedUntil" > now()`)
	})
	t.Run("续租只滑动时钟不改状态（回池/置败语义不被续租绕过）", func(t *testing.T) {
		assert.NotContains(t, block, "SET status")
	})
}

func TestMarketReleaseExpiredClaimsAnchor(t *testing.T) {
	block := sqlQueryBlock(t, "market.sql", "MarketReleaseExpiredClaims")
	t.Run("过期回池：CLAIMED 且租约已过 → PENDING（work stealing 前置）", func(t *testing.T) {
		assert.Contains(t, block, `WHERE status = 'CLAIMED' AND "claimedUntil" < now()`)
		assert.Contains(t, block, `SET status = 'PENDING'`)
	})
	t.Run("回池必须清空属主/租约/冻结三字段", func(t *testing.T) {
		assert.Contains(t, block, `"claimedBy" = NULL`)
		assert.Contains(t, block, `"claimedUntil" = NULL`)
		assert.Contains(t, block, `"frozenCredits" = 0`)
	})
}

func TestMarketTerminalWriteCASAnchors(t *testing.T) {
	tests := []struct {
		name      string
		query     string
		fragments []string
	}{
		{
			name:  "幽灵换入拒绝：settle 仅本人 CLAIMED 可 SWAPPED",
			query: "MarketSettleRelayTxUpdateJob",
			fragments: []string{
				`AND status = 'CLAIMED'`,
				`AND "claimedBy" = sqlc.arg('claimedBy')`,
				`SET status = 'SWAPPED'`,
			},
		},
		{
			name:  "幽灵置败拒绝：mark-failed 仅本人 CLAIMED 可 FAILED",
			query: "MarketMarkJobFailed",
			fragments: []string{
				`AND status = 'CLAIMED'`,
				`AND "claimedBy" = sqlc.arg('claimedBy')`,
				`SET status = 'FAILED'`,
			},
		},
		{
			name:  "主动放弃：release 仅本人 CLAIMED 可回 PENDING",
			query: "MarketReleaseClaim",
			fragments: []string{
				`AND status = 'CLAIMED'`,
				`AND "claimedBy" = sqlc.arg('claimedBy')`,
				`SET status = 'PENDING'`,
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			block := sqlQueryBlock(t, "market.sql", tt.query)
			for _, fragment := range tt.fragments {
				assert.Contains(t, block, fragment)
			}
		})
	}
}
