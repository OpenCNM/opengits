package ogis

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestTopologicalScorer_TestPenalization(t *testing.T) {
	scorer := NewHeuristicTopologicalScorer()

	testPaths := []string{
		"internal/ogis/search_test.go",
		"tests/unit/search.test.ts",
		"src/components/button.spec.tsx",
		"mock/client.go",
		"internal/fixtures/data.json",
		"examples/basic/main.go",
	}

	for _, p := range testPaths {
		mult := scorer.ScorePath(p)
		assert.LessOrEqual(t, mult, 0.60, "path %s should be penalized", p)
	}
}

func TestTopologicalScorer_Heuristics(t *testing.T) {
	scorer := NewHeuristicTopologicalScorer()

	assert.InDelta(t, 1.30, scorer.ScorePath("README.md"), 0.01)
	assert.InDelta(t, 1.30, scorer.ScorePath("main.go"), 0.01)

	assert.InDelta(t, 1.15, scorer.ScorePath("architecture.md"), 0.01)

	assert.InDelta(t, 1.0, scorer.ScorePath("internal/ogis/search.go"), 0.01)

	assert.InDelta(t, 0.90, scorer.ScorePath("a/b/c/d/e/f/g.ts"), 0.01)
}

func TestTopologicalScorer_RSGNodes(t *testing.T) {
	nodes := []TopologicalNodeMeta{
		{
			Path:         "cmd/server/main.go",
			IsEntryPoint: true,
			Role:         "entry_point",
		},
		{
			Path:       "internal/core/types.go",
			Role:       "core_contract",
			IsBackbone: true,
			InDegree:   8,
		},
		{
			Path: "internal/pipeline/worker.go",
			Role: "pipeline_flow",
		},
		{
			Path: "internal/core/types_test.go",
			Role: "core_contract",
		},
	}

	scorer := NewTopologicalScorer(nodes)

	assert.InDelta(t, 1.30, scorer.ScorePath("cmd/server/main.go"), 0.01)

	assert.InDelta(t, 1.59, scorer.ScorePath("internal/core/types.go"), 0.01)

	assert.InDelta(t, 1.15, scorer.ScorePath("internal/pipeline/worker.go"), 0.01)

	assert.LessOrEqual(t, scorer.ScorePath("internal/core/types_test.go"), 0.80)
}
