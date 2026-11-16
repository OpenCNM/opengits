package rsg

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type rsgGoldenFixture struct {
	GitSha   string            `json:"gitSha"`
	Files    []SourceFileInput `json:"files"`
	Expected struct {
		EntryPoints       []string `json:"entryPoints"`
		BackboneNodes     []string `json:"backboneNodes"`
		CoreContractNodes []string `json:"coreContractNodes"`
		PipelineNodes     []string `json:"pipelineNodes"`
		Edges             []struct {
			Source string `json:"source"`
			Target string `json:"target"`
		} `json:"edges"`
		Nodes map[string]struct {
			Path         string   `json:"path"`
			Language     string   `json:"language"`
			InDegree     int      `json:"inDegree"`
			OutDegree    int      `json:"outDegree"`
			PageRank     float64  `json:"pageRank"`
			Role         string   `json:"role"`
			IsBackbone   bool     `json:"isBackbone"`
			IsEntryPoint bool     `json:"isEntryPoint"`
			Imports      []string `json:"imports"`
			ImportedBy   []string `json:"importedBy"`
		} `json:"nodes"`
		Meta SemanticGraphMeta `json:"meta"`
	} `json:"expectedGraph"`
}

func assertSortedSliceEqual(t *testing.T, got, want []string, name string) {
	t.Helper()
	g := append([]string(nil), got...)
	w := append([]string(nil), want...)
	sort.Strings(g)
	sort.Strings(w)
	assert.Equal(t, w, g, "%s sorted slice mismatch", name)
}

// 🧪 [1.18.1.1] TestRSGGoldenParity TS/Go 拓扑角色与 PageRank 双端黄金对拍
func TestRSGGoldenParity(t *testing.T) {
	defs := DefaultLanguageDefinitions()

	raw, err := os.ReadFile("testdata/rsg.golden.json")
	if err != nil {
		for _, alt := range []string{"../../testdata/rsg.golden.json", "services/worker-sidecar/testdata/rsg.golden.json", "/src/services/worker-sidecar/testdata/rsg.golden.json"} {
			if altRaw, altErr := os.ReadFile(alt); altErr == nil {
				raw = altRaw
				err = nil
				break
			}
		}
	}
	if err != nil {
		t.Skip("rsg.golden.json missing (regen via 冻结手工维护契约（原 TS 生成脚本已退役）)")
	}

	var fixture rsgGoldenFixture
	require.NoError(t, json.Unmarshal(raw, &fixture))

	graph, err := defs.BuildSemanticGraph(fixture.Files)
	require.NoError(t, err)

	t.Run("EntryPoints parity", func(t *testing.T) {
		assertSortedSliceEqual(t, graph.EntryPoints, fixture.Expected.EntryPoints, "EntryPoints")
	})

	t.Run("CoreContractNodes parity", func(t *testing.T) {
		assertSortedSliceEqual(t, graph.CoreContractNodes, fixture.Expected.CoreContractNodes, "CoreContractNodes")
	})

	t.Run("PipelineNodes parity", func(t *testing.T) {
		assertSortedSliceEqual(t, graph.PipelineNodes, fixture.Expected.PipelineNodes, "PipelineNodes")
	})

	t.Run("BackboneNodes parity", func(t *testing.T) {
		assertSortedSliceEqual(t, graph.BackboneNodes, fixture.Expected.BackboneNodes, "BackboneNodes")
	})

	t.Run("Node-level attributes and PageRank parity (< 1e-4)", func(t *testing.T) {
		for path, expNode := range fixture.Expected.Nodes {
			gotNode, ok := graph.Nodes[path]
			require.True(t, ok, "missing node %s in Go graph", path)

			assert.Equal(t, expNode.InDegree, gotNode.InDegree, "node %s InDegree mismatch", path)
			assert.Equal(t, expNode.OutDegree, gotNode.OutDegree, "node %s OutDegree mismatch", path)
			assert.Equal(t, expNode.Role, string(gotNode.Role), "node %s Role mismatch", path)
			assert.Equal(t, expNode.IsEntryPoint, gotNode.IsEntryPoint, "node %s IsEntryPoint mismatch", path)
			assert.Equal(t, expNode.IsBackbone, gotNode.IsBackbone, "node %s IsBackbone mismatch", path)
			assert.InDelta(t, expNode.PageRank, gotNode.PageRank, 1e-4, "node %s PageRank delta exceeds 1e-4", path)
		}
	})

	t.Run("Meta hygiene", func(t *testing.T) {
		assert.Equal(t, fixture.Expected.Meta.TotalFiles, graph.Meta.TotalFiles)
		assert.Equal(t, fixture.Expected.Meta.DroppedTestEdges, graph.Meta.DroppedTestEdges)
		assert.Equal(t, fixture.Expected.Meta.UnresolvedImportCount, graph.Meta.UnresolvedImportCount)
	})
}

// 🧪 [1.18.1.2] TestRSGDanglingPageRank 悬空节点质量全量回灌不泄漏
func TestRSGDanglingPageRank(t *testing.T) {
	nodes := []string{"a.ts", "b.ts", "sink.ts"}
	adjacency := map[string][]string{
		"a.ts":    {"b.ts"},
		"b.ts":    {"sink.ts"},
		"sink.ts": {},
	}

	ranks := ComputePageRank(nodes, adjacency, 0.85, 40)
	total := 0.0
	for _, n := range nodes {
		total += ranks[n]
	}

	assert.InDelta(t, 1.0, total, 0.05, "PageRank total should sum to ~1.0")

	sinkRank := ranks["sink.ts"]
	bRank := ranks["b.ts"]
	assert.Greater(t, sinkRank, bRank*0.5, "sinkRank must be > bRank * 0.5")
	assert.Less(t, sinkRank, total*0.6, "sinkRank must be < total * 0.6")
}

// 🧪 [1.18.2.1] TestRSGDeterministicTieBreak 歧义同名文件确定性决胜
func TestRSGDeterministicTieBreak(t *testing.T) {
	tests := []struct {
		name       string
		candidates []string
		current    string
		want       string
	}{
		{
			name: "shared prefix wins",
			candidates: []string{
				"packages/core/src/util.ts",
				"packages/api/src/util.ts",
			},
			current: "packages/api/src/service.ts",
			want:    "packages/api/src/util.ts",
		},
		{
			name: "shallowest wins when no shared prefix",
			candidates: []string{
				"packages/b/util.ts",
				"packages/a/util.ts",
			},
			current: "util.ts",
			want:    "packages/a/util.ts",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := PickDeterministicCandidate(tt.candidates, tt.current)
			assert.Equal(t, tt.want, got)
		})
	}
}

// 🧪 [1.18.3.1] TestRSGStoreRoundTrip 图谱产物落盘与还原
func TestRSGStoreRoundTrip(t *testing.T) {
	tmpDir := t.TempDir()
	owner, repo, sha := "testowner", "testrepo", "abcd1234ef56"

	artifact := &SemanticGraphArtifact{
		Version:           2,
		GeneratedAt:       "2026-09-09T00:00:00Z",
		GitSha:            sha,
		EntryPoints:       []string{"src/index.ts"},
		BackboneNodes:     []string{"src/index.ts", "src/db.ts"},
		CoreContractNodes: []string{"src/db.ts"},
		PipelineNodes:     []string{},
		Nodes: []SemanticGraphArtifactNode{
			{
				Path:         "src/index.ts",
				Language:     "typescript",
				InDegree:     0,
				OutDegree:    1,
				PageRank:     0.5,
				Role:         RoleEntryPoint,
				IsBackbone:   true,
				IsEntryPoint: true,
			},
			{
				Path:         "src/db.ts",
				Language:     "typescript",
				InDegree:     1,
				OutDegree:    0,
				PageRank:     0.5,
				Role:         RoleCoreContract,
				IsBackbone:   true,
				IsEntryPoint: false,
			},
		},
		SymbolsByFile: map[string][]SymbolEntry{},
		SoftEdges:     []SoftGraphEdge{},
		GoldenSymbols: []GoldenSymbol{},
		CallEdges:     []CallEdge{},
		Meta: SemanticGraphMeta{
			TotalFiles: 2,
		},
	}

	savedPath, err := SaveSemanticGraphArtifact(tmpDir, owner, repo, sha, artifact)
	require.NoError(t, err)

	expectedPath := filepath.Join(tmpDir, owner, repo, sha+".json")
	assert.Equal(t, expectedPath, savedPath)

	loaded, err := LoadSemanticGraphArtifact(tmpDir, owner, repo, sha)
	require.NoError(t, err)

	assert.Equal(t, artifact.Version, loaded.Version)
	assert.Equal(t, artifact.GitSha, loaded.GitSha)
	assert.Len(t, loaded.Nodes, len(artifact.Nodes))
}

func TestRSGMaxParseFilesSkipping(t *testing.T) {
	defs := DefaultLanguageDefinitions()

	// Override maxParseFiles to 2
	defs.Config.MaxParseFiles = 2

	files := []SourceFileInput{
		{Path: "src/a.ts", Content: "import { b } from './b';"},
		{Path: "src/b.ts", Content: "import { c } from './c';"},
		{Path: "src/c.ts", Content: "export const c = 1;"},
	}

	graph, err := defs.BuildSemanticGraph(files)
	require.NoError(t, err)

	// All 3 files must remain in the graph
	assert.Equal(t, 3, graph.Meta.TotalFiles)
	assert.Equal(t, 1, graph.Meta.SkippedFiles)
	assert.Len(t, graph.NodeList, 3)

	// src/c.ts must still be present as a node and resolvable as an import target
	cNode, ok := graph.Nodes["src/c.ts"]
	require.True(t, ok, "missing node src/c.ts in graph")
	assert.Equal(t, 1, cNode.InDegree)
}

// 🧪 [1.18.2.2] TestRSGNonContentDirFiltering 非代码目录排除
func TestRSGNonContentDirFiltering(t *testing.T) {
	patterns := DefaultIngestPatterns()
	defs := DefaultLanguageDefinitions()

	root := t.TempDir()
	graphDir := t.TempDir()
	owner, repo, sha := "o", "r", "test-sha-filtering"
	dir := filepath.Join(root, owner, repo, sha)

	testFiles := map[string]string{
		"src/index.ts":              "import { util } from './util'; export function run() {}",
		"src/util.ts":               "export const util = 1;",
		"node_modules/pkg/index.ts": "export const forbidden = true;",
		".git/hooks/pre-commit.sh":  "exit 0",
		"dist/bundle.js":            "console.log(1);",
	}

	var nodes []GitNode
	for relPath, content := range testFiles {
		p := filepath.Join(dir, filepath.FromSlash(relPath))
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0755))
		require.NoError(t, os.WriteFile(p, []byte(content), 0644))
		nodes = append(nodes, GitNode{
			Path: relPath,
			Type: "blob",
			Size: int64(len(content)),
		})
	}

	artifact, err := BuildRepoSemanticGraph(context.Background(), root, graphDir, owner, repo, sha, defs, patterns, nodes)
	require.NoError(t, err)

	assert.Equal(t, 2, artifact.Meta.TotalFiles, "node_modules, .git, and dist should be filtered out")
	for _, n := range artifact.Nodes {
		assert.True(t, n.Path == "src/index.ts" || n.Path == "src/util.ts", "unexpected node %q in artifact", n.Path)
	}
}

type testMemoryGateMock struct {
	acquireCalls int
	releaseCalls int
	acquiredCtx  context.Context
	weightPassed int
	acquireErr   error
}

func (m *testMemoryGateMock) Acquire(ctx context.Context, weight int) error {
	m.acquireCalls++
	m.acquiredCtx = ctx
	m.weightPassed = weight
	return m.acquireErr
}

func (m *testMemoryGateMock) Release(weight int) {
	m.releaseCalls++
}

func (m *testMemoryGateMock) CalculateJobWeight(nodeCount int, isCodeRepo bool) int {
	return 4
}

// TestBuildRepoSemanticGraph_ContextCancellation 测试建图循环的 ctx 取消拦截
func TestBuildRepoSemanticGraph_ContextCancellation(t *testing.T) {
	root := t.TempDir()
	graphDir := t.TempDir()
	owner, repo, sha := "test-owner", "test-repo", "cancel-sha"
	dir := filepath.Join(root, owner, repo, sha)
	require.NoError(t, os.MkdirAll(dir, 0755))

	p := filepath.Join(dir, "index.ts")
	require.NoError(t, os.WriteFile(p, []byte("export const x = 1;"), 0644))

	nodes := []GitNode{{Path: "index.ts", Type: "blob", Size: 19}}
	defs := DefaultLanguageDefinitions()

	t.Run("pre-canceled context aborts build immediately", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		art, berr := BuildRepoSemanticGraph(ctx, root, graphDir, owner, repo, sha, defs, nil, nodes)
		assert.ErrorIs(t, berr, context.Canceled)
		assert.Nil(t, art)
	})
}

// 🧪 [1.18.4.1] TestRSGSymbolExtractionAndCallEdges 原生符号提取与图谱接地
func TestRSGSymbolExtractionAndCallEdges(t *testing.T) {
	defs := DefaultLanguageDefinitions()

	files := []SourceFileInput{
		{
			Path: "src/main.ts",
			Content: `import { processUser } from './user';

export function run() {
  processUser();
}
`,
		},
		{
			Path: "src/user.ts",
			Content: `import { dbQuery } from './db';

export interface User {
  id: string;
}

export function processUser() {
  dbQuery();
}
`,
		},
		{
			Path: "src/db.ts",
			Content: `export function dbQuery() {
  return 1;
}
`,
		},
	}

	graph, err := defs.BuildSemanticGraph(files)
	require.NoError(t, err)

	t.Run("SymbolsByFile populated correctly", func(t *testing.T) {
		require.Len(t, graph.SymbolsByFile["src/main.ts"], 1)
		assert.Equal(t, "run", graph.SymbolsByFile["src/main.ts"][0].Name)
		assert.Equal(t, "function", graph.SymbolsByFile["src/main.ts"][0].Kind)
		assert.True(t, graph.SymbolsByFile["src/main.ts"][0].Exported)

		require.Len(t, graph.SymbolsByFile["src/user.ts"], 2)
		symMap := make(map[string]SymbolEntry)
		for _, s := range graph.SymbolsByFile["src/user.ts"] {
			symMap[s.Name] = s
		}
		assert.Equal(t, "type", symMap["User"].Kind)
		assert.Equal(t, "function", symMap["processUser"].Kind)

		require.Len(t, graph.SymbolsByFile["src/db.ts"], 1)
		assert.Equal(t, "dbQuery", graph.SymbolsByFile["src/db.ts"][0].Name)
	})

	t.Run("CallEdges resolved across files", func(t *testing.T) {
		require.Len(t, graph.CallEdges, 2)

		edge1 := graph.CallEdges[0]
		assert.Equal(t, "src/main.ts", edge1.CallerFile)
		assert.Equal(t, "run", edge1.CallerSymbol)
		assert.Equal(t, "src/user.ts", edge1.CalleeFile)
		assert.Equal(t, "processUser", edge1.CalleeSymbol)

		edge2 := graph.CallEdges[1]
		assert.Equal(t, "src/user.ts", edge2.CallerFile)
		assert.Equal(t, "processUser", edge2.CallerSymbol)
		assert.Equal(t, "src/db.ts", edge2.CalleeFile)
		assert.Equal(t, "dbQuery", edge2.CalleeSymbol)
	})

	t.Run("Meta statistics", func(t *testing.T) {
		assert.Equal(t, 3, graph.Meta.TotalFiles)
		assert.Equal(t, 3, graph.Meta.ASTParsedFiles)
		assert.Equal(t, 0, graph.Meta.SkippedFiles)
	})
}
