package concept

import (
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/chapter"
)

// ─────────────────────────────────────────────────────────────
// canonicalName 组代表刷新（移植 apps/client/src/lib/mcp/concept-canonical.ts
// planCanonicalGroups:33-71）：同 canonicalKey 的变体名按
// 频率降序 → 更短 → JsLocaleCompare 字典序选出代表名——L1 归并层不再
// 每变体各自为名（"1. 事件循环" 与 "事件循环" 收敛）。
// ─────────────────────────────────────────────────────────────

// CanonicalVariant 组内变体统计。
type CanonicalVariant struct {
	Name  string
	Count int
}

// PlanCanonicalGroups 选出每组代表名（确定性：频率 → 短名 → 字典序）。
func PlanCanonicalGroups(groups map[string][]CanonicalVariant) map[string]string {
	representatives := make(map[string]string, len(groups))
	for key, variants := range groups {
		if strings.TrimSpace(key) == "" || len(variants) == 0 {
			continue
		}
		sorted := make([]CanonicalVariant, len(variants))
		copy(sorted, variants)
		sort.SliceStable(sorted, func(i, j int) bool {
			a, b := sorted[i], sorted[j]
			if a.Count != b.Count {
				return a.Count > b.Count
			}
			ra, rb := []rune(a.Name), []rune(b.Name)
			if len(ra) != len(rb) {
				return len(ra) < len(rb)
			}
			return chapter.JsLocaleCompare(a.Name, b.Name) < 0
		})
		representatives[key] = sorted[0].Name
	}
	return representatives
}
