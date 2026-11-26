package concept

import (
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/chapter"
)

type CanonicalVariant struct {
	Name  string
	Count int
}

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
