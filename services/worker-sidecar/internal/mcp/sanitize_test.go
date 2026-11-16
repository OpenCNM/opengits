package mcp

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestSanitizeDatabaseURL Prisma URL 参数清洗（本地冒烟发现的真实 bug 回归）。
func TestSanitizeDatabaseURL(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "strip schema only",
			in:   "postgresql://u:p@h:5433/db?schema=public",
			want: "postgresql://u:p@h:5433/db",
		},
		{
			name: "convert connection_limit to pool_max_conns",
			in:   "postgresql://u:p@h:5433/db?schema=public&connection_limit=8",
			want: "postgresql://u:p@h:5433/db?pool_max_conns=8",
		},
		{
			name: "strip pool_timeout while converting connection_limit",
			in:   "postgresql://u:p@h:5433/db?schema=public&connection_limit=8&pool_timeout=10",
			want: "postgresql://u:p@h:5433/db?pool_max_conns=8",
		},
		{
			name: "preserve existing pool_max_conns while stripping schema",
			in:   "postgresql://u:p@h:5433/db?pool_max_conns=4&schema=public",
			want: "postgresql://u:p@h:5433/db?pool_max_conns=4",
		},
		{
			name: "plain url without query params",
			in:   "postgresql://u:p@h:5433/db",
			want: "postgresql://u:p@h:5433/db",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeDatabaseURL(tt.in)
			assert.Equal(t, tt.want, got)
		})
	}
}
