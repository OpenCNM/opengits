package search

import (
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

var placeholderRe = regexp.MustCompile(`\$\d+`)

func TestBuildVersionFilterPredicate(t *testing.T) {
	t.Run("谓词仅引用 精确/前缀/仓库ID 三个占位符（无第三档子串参数位）", func(t *testing.T) {
		sql := BuildVersionFilterPredicate(5, 6)
		assert.Contains(t, sql, `"DocumentChunk"."semVerLabel" = $5`)
		assert.Contains(t, sql, `"Repository"."semVerLabel" = $5`)
		assert.Contains(t, sql, `"Repository"."branch" = $5`)
		assert.Contains(t, sql, `"DocumentChunk"."semVerLabel" ILIKE $6`)
		assert.Contains(t, sql, `"Repository"."semVerLabel" ILIKE $6`)
		assert.Contains(t, sql, `"Repository"."branch" ILIKE $6`)

		assert.Contains(t, sql, `"DocumentChunk"."semVerLabel" IS NULL AND "Repository"."semVerLabel" IS NULL`)

		placeholders := map[string]bool{}
		for _, m := range placeholderRe.FindAllString(sql, -1) {
			placeholders[m] = true
		}
		assert.Equal(t, map[string]bool{"$1": true, "$5": true, "$6": true}, placeholders,
			"版本谓词只允许 精确($5)/前缀($6)/仓库ID($1) 三个参数位——出现第四个位即意味着引入了子串档")
	})

	t.Run("LIKE 前缀语义锁定（模拟 PG LIKE 行为表）", func(t *testing.T) {
		likePrefix := func(pattern, value string) bool {
			if !strings.HasSuffix(pattern, "%") {
				return pattern == value
			}
			return strings.HasPrefix(value, strings.TrimSuffix(pattern, "%"))
		}
		tests := []struct {
			name    string
			version string
			label   string
			want    bool
		}{
			{name: "v5 不误命中 v15.0.0（裸子串已废除）", version: "v5", label: "v15.0.0", want: false},
			{name: "v5 前缀合法命中 v50", version: "v5", label: "v50", want: true},
			{name: "v15 前缀命中 v15.0.0", version: "v15", label: "v15.0.0", want: true},
			{name: "v15.0.0 精确命中自身", version: "v15.0.0", label: "v15.0.0", want: true},
			{name: "release 分支前缀命中 release/v15", version: "release", label: "release/v15", want: true},
			{name: "v16 不命中 v15.0.0", version: "v16", label: "v15.0.0", want: false},
			{name: "5 不再命中 v15.0.0（旧子串行为的回归锁）", version: "5", label: "v15.0.0", want: false},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				exact := tt.version == tt.label
				prefix := likePrefix(tt.version+"%", tt.label)
				assert.Equal(t, tt.want, exact || prefix)
			})
		}
	})
}
