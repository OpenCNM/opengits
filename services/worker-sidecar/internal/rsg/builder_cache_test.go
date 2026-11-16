package rsg

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildSemanticGraph_ShaCacheEfficiency(t *testing.T) {
	defs := DefaultLanguageDefinitions()

	cache := NewAstCache(50)
	SetDefaultAstCache(cache)
	defer SetDefaultAstCache(NewAstCache(DefaultMaxAstCacheEntries))

	files := []SourceFileInput{
		{Path: "src/math.ts", Content: "export function add(a: number, b: number): number { return a + b; }", Sha: "sha-math-v1"},
		{Path: "src/service.ts", Content: "import { add } from './math';\nexport function calc(x: number): number { return add(x, 10); }", Sha: "sha-service-v1"},
		{Path: "src/main.ts", Content: "import { calc } from './service';\nexport function main() { return calc(42); }", Sha: "sha-main-v1"},
	}

	// 1st Build: all 3 files miss cache and get populated
	graph1, err := defs.BuildSemanticGraph(files)
	require.NoError(t, err)
	require.NotNil(t, graph1)

	stats1 := cache.Stats()
	assert.Equal(t, int64(0), stats1.Hits)
	assert.Equal(t, int64(3), stats1.Misses)
	assert.Equal(t, 3, cache.Len())

	// 2nd Build with same files & SHAs: 100% cache hits
	graph2, err := defs.BuildSemanticGraph(files)
	require.NoError(t, err)
	require.NotNil(t, graph2)

	stats2 := cache.Stats()
	assert.Equal(t, int64(3), stats2.Hits)
	assert.Equal(t, int64(3), stats2.Misses)

	// Invariant: Outputs of cached vs non-cached build are mathematically identical
	assert.Equal(t, len(graph1.Nodes), len(graph2.Nodes))
	assert.Equal(t, len(graph1.Edges), len(graph2.Edges))
	assert.Equal(t, len(graph1.GoldenSymbols), len(graph2.GoldenSymbols))
	for path, node1 := range graph1.Nodes {
		node2, exists := graph2.Nodes[path]
		require.True(t, exists)
		assert.Equal(t, node1.InDegree, node2.InDegree)
		assert.Equal(t, node1.OutDegree, node2.OutDegree)
		assert.Equal(t, node1.PageRank, node2.PageRank)
		assert.Equal(t, node1.Role, node2.Role)
	}

	// 3rd Build: Incremental update where only 1 file is modified (math.ts modified to v2)
	incrementalFiles := []SourceFileInput{
		{Path: "src/math.ts", Content: "export function add(a: number, b: number): number { return a + b + 0; }", Sha: "sha-math-v2"},
		{Path: "src/service.ts", Content: files[1].Content, Sha: files[1].Sha},
		{Path: "src/main.ts", Content: files[2].Content, Sha: files[2].Sha},
	}

	graph3, err := defs.BuildSemanticGraph(incrementalFiles)
	require.NoError(t, err)
	require.NotNil(t, graph3)

	stats3 := cache.Stats()
	// Hits increased by 2 (service.ts, main.ts), Misses increased by 1 (math.ts)
	assert.Equal(t, int64(5), stats3.Hits)
	assert.Equal(t, int64(4), stats3.Misses)
}
