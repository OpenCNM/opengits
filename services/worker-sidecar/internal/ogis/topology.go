package ogis

import (
	"strings"
)

type TopologicalNodeMeta struct {
	Path         string  `json:"path"`
	InDegree     int     `json:"inDegree"`
	OutDegree    int     `json:"outDegree"`
	PageRank     float64 `json:"pageRank"`
	Role         string  `json:"role"`
	IsBackbone   bool    `json:"isBackbone"`
	IsEntryPoint bool    `json:"isEntryPoint"`
}

type TopologicalScorer struct {
	nodeWeights map[string]float64
}

func NewTopologicalScorer(nodes []TopologicalNodeMeta) *TopologicalScorer {
	weights := make(map[string]float64, len(nodes))
	for _, n := range nodes {
		normPath := normalizePathKey(n.Path)
		if normPath == "" {
			continue
		}
		weights[normPath] = computeNodeMultiplier(n)
	}
	return &TopologicalScorer{
		nodeWeights: weights,
	}
}

func NewHeuristicTopologicalScorer() *TopologicalScorer {
	return &TopologicalScorer{
		nodeWeights: make(map[string]float64),
	}
}

var DefaultTopologicalScorer = NewHeuristicTopologicalScorer()

func (s *TopologicalScorer) ScorePath(path string) float64 {
	normPath := normalizePathKey(path)
	if normPath == "" {
		return 1.0
	}

	isTest := isTestOrAuxiliaryPath(normPath)

	if s != nil && len(s.nodeWeights) > 0 {
		if w, ok := s.nodeWeights[normPath]; ok {
			if isTest {
				return clampMultiplier(w * 0.55)
			}
			return clampMultiplier(w)
		}
	}

	mult := computeHeuristicMultiplier(normPath)
	if isTest {
		mult *= 0.55
	}
	return clampMultiplier(mult)
}

func computeNodeMultiplier(n TopologicalNodeMeta) float64 {
	boost := 0.0

	if n.IsEntryPoint || n.Role == "entry_point" {
		boost += 0.30
	}
	if n.IsBackbone || n.Role == "core_contract" {
		boost += 0.35
	} else if n.Role == "pipeline_flow" {
		boost += 0.15
	}

	if n.InDegree > 0 {
		inBoost := float64(n.InDegree) * 0.03
		if inBoost > 0.30 {
			inBoost = 0.30
		}
		boost += inBoost
	}

	if boost > 0.65 {
		boost = 0.65
	}

	return 1.0 + boost
}

func computeHeuristicMultiplier(normPath string) float64 {
	if isRootOrEntryDoc(normPath) {
		return 1.30
	}
	if isTopLevelDoc(normPath) {
		return 1.15
	}
	if countPathDepth(normPath) > 5 {
		return 0.90
	}
	return 1.0
}

func normalizePathKey(p string) string {
	clean := strings.TrimSpace(strings.ToLower(p))
	clean = strings.TrimPrefix(clean, "/")
	clean = strings.TrimPrefix(clean, "./")
	return clean
}

func isTestOrAuxiliaryPath(p string) bool {
	if strings.HasSuffix(p, "_test.go") ||
		strings.HasSuffix(p, ".test.ts") ||
		strings.HasSuffix(p, ".test.tsx") ||
		strings.HasSuffix(p, ".test.js") ||
		strings.HasSuffix(p, ".test.jsx") ||
		strings.HasSuffix(p, ".spec.ts") ||
		strings.HasSuffix(p, ".spec.tsx") ||
		strings.HasSuffix(p, ".spec.js") ||
		strings.HasSuffix(p, ".spec.jsx") {
		return true
	}

	auxSegments := []string{
		"/test/", "/tests/", "/testing/",
		"/mock/", "/mocks/",
		"/fixtures/", "/fixture/",
		"/examples/", "/example/",
		"/testdata/",
	}
	for _, seg := range auxSegments {
		if strings.Contains(p, seg) {
			return true
		}
	}

	auxPrefixes := []string{
		"test/", "tests/", "testing/",
		"mock/", "mocks/",
		"fixtures/", "fixture/",
		"examples/", "example/",
		"testdata/",
	}
	for _, pre := range auxPrefixes {
		if strings.HasPrefix(p, pre) {
			return true
		}
	}

	return false
}

func isRootOrEntryDoc(p string) bool {
	if p == "readme.md" ||
		p == "index.md" ||
		p == "index.ts" ||
		p == "index.js" ||
		p == "main.go" ||
		p == "main.ts" ||
		p == "main.py" ||
		p == "app.ts" ||
		p == "app.js" {
		return true
	}
	base := p
	if idx := strings.LastIndex(p, "/"); idx != -1 {
		base = p[idx+1:]
	}
	return base == "readme.md" && countPathDepth(p) <= 2
}

func isTopLevelDoc(p string) bool {
	if !strings.HasSuffix(p, ".md") && !strings.HasSuffix(p, ".mdx") {
		return false
	}
	return countPathDepth(p) <= 1
}

func countPathDepth(p string) int {
	clean := strings.Trim(p, "/")
	if clean == "" {
		return 0
	}
	return strings.Count(clean, "/")
}

func clampMultiplier(m float64) float64 {
	if m < 0.20 {
		return 0.20
	}
	if m > 2.0 {
		return 2.0
	}
	return m
}
