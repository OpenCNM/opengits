package cognitive

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func findRealArtifacts(t *testing.T) []string {
	t.Helper()
	matches, _ := filepath.Glob(filepath.Join("..", "..", "storage", "graphs", "*", "*", "*.json"))
	return matches
}

func TestSegmentedV3RoundTrip(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T)
	}{
		{
			name: "合成产物往返逐字段等价",
			run: func(t *testing.T) {
				artifact := &SemanticGraphArtifact{
					Version: 2, GeneratedAt: "2026-10-12T00:00:00Z", GitSha: "abc123",
					Nodes: []SemanticGraphArtifactNode{
						{Path: "a.ts", InDegree: 2, OutDegree: 1, PageRank: 0.5, Role: "core"},
						{Path: "b.py", Role: "leaf"},
					},
					EntryPoints:       []string{"main.ts"},
					BackboneNodes:     []string{"a.ts"},
					CoreContractNodes: []string{"a.ts", "b.py"},
					PipelineNodes:     []string{},
					SymbolsByFile: map[string][]SymbolEntry{
						"a.ts":        {{Name: "foo", Kind: "function", StartLine: 1, EndLine: 9, Exported: true, Golden: true, Importers: 3}, {Name: "Bar", Kind: "type", StartLine: 11, EndLine: 20}},
						"b.py":        {{Name: "baz", Kind: "function", StartLine: 3, EndLine: 5}},
						"z/深路径/中文.go": {{Name: "Qux", Kind: "type", Exported: true}},
					},
					Edges:         []SemanticGraphEdge{{Source: "a.ts", Target: "b.py"}},
					SoftEdges:     []SoftGraphEdge{{Source: "a.ts", Target: "z/深路径/中文.go"}},
					CallEdges:     []CallEdge{{CallerFile: "a.ts", CallerSymbol: "foo", CalleeFile: "b.py", CalleeSymbol: "baz", Line: 7}},
					GoldenSymbols: []GoldenSymbol{{Name: "foo", File: "a.ts"}},
				}
				enc, err := encodeSegmentedV3(artifact)
				require.NoError(t, err)
				require.True(t, isSegmentedV3(enc), "必须产出 v3 容器魔数")

				dec, err := decodeSegmentedV3(enc)
				require.NoError(t, err)
				assert.Equal(t, artifact, dec, "v3 往返必须逐字段等价")
			},
		},
		{
			name: "真实产物 v2 全量读出 == Save(v3) 后 Load 读出",
			run: func(t *testing.T) {
				files := findRealArtifacts(t)
				if len(files) == 0 {
					t.Skip("本地无真实产物（storage/graphs 为空）")
				}
				tested := 0
				for _, f := range files {
					if tested >= 3 {
						break
					}
					raw, err := os.ReadFile(f)
					require.NoError(t, err)
					if isSegmentedV3(raw) {
						continue
					}
					var want SemanticGraphArtifact
					require.NoError(t, json.Unmarshal(raw, &want), "夹具必须是合法 v2")
					if want.Version != 2 {
						continue
					}

					dir := t.TempDir()
					owner, repo := "seg-owner", "seg-repo"
					path, err := SaveSemanticGraphArtifact(dir, owner, repo, want.GitSha, &want)
					require.NoError(t, err)

					got, err := LoadSemanticGraphArtifact(dir, owner, repo, want.GitSha)
					require.NoError(t, err)
					assert.Equal(t, &want, got, "文件 %s：v2→v3→读出必须逐字段等价", filepath.Base(f))
					_ = path
					tested++
				}
				require.NotZero(t, tested, "至少对拍一个真实产物")
			},
		},
		{
			name: "惰性单文件解码与全量一致",
			run: func(t *testing.T) {
				artifact := &SemanticGraphArtifact{
					Version: 2, GitSha: "lazy1",
					SymbolsByFile: map[string][]SymbolEntry{
						"x.ts": {{Name: "alpha", Kind: "function", Exported: true}},
						"y.ts": {{Name: "beta"}, {Name: "gamma", Golden: true}},
					},
				}
				dir := t.TempDir()
				_, err := SaveSemanticGraphArtifact(dir, "o", "r", "lazy1", artifact)
				require.NoError(t, err)

				lz, err := OpenSemanticGraphArtifactLazy(dir, "o", "r", "lazy1")
				require.NoError(t, err)
				defer lz.Close()

				assert.Equal(t, []string{"x.ts", "y.ts"}, lz.Files())
				xs, err := lz.SymbolsForFile("x.ts")
				require.NoError(t, err)
				assert.Equal(t, artifact.SymbolsByFile["x.ts"], xs)
				ys, err := lz.SymbolsForFile("y.ts")
				require.NoError(t, err)
				assert.Equal(t, artifact.SymbolsByFile["y.ts"], ys)
				missing, err := lz.SymbolsForFile("absent.ts")
				require.NoError(t, err)
				assert.Nil(t, missing)
			},
		},
		{
			name: "惰性调用边解码与全量一致",
			run: func(t *testing.T) {
				artifact := &SemanticGraphArtifact{
					Version: 2, GitSha: "lazy-edges",
					SymbolsByFile: map[string][]SymbolEntry{"a.ts": {{Name: "run", Kind: "function"}}},
					CallEdges: []CallEdge{
						{CallerFile: "a.ts", CallerSymbol: "run", CalleeFile: "b.ts", CalleeSymbol: "work", Line: 3},
						{CallerFile: "b.ts", CallerSymbol: "work", CalleeFile: "b.ts", CalleeSymbol: "init", Line: 7},
					},
				}
				dir := t.TempDir()
				_, err := SaveSemanticGraphArtifact(dir, "o", "r", "lazy-edges", artifact)
				require.NoError(t, err)

				lz, err := OpenSemanticGraphArtifactLazy(dir, "o", "r", "lazy-edges")
				require.NoError(t, err)
				defer func() { require.NoError(t, lz.Close()) }()

				got, err := lz.CallEdges()
				require.NoError(t, err)
				assert.Equal(t, artifact.CallEdges, got)
			},
		},
		{
			name: "无调用边产物惰性读取返回空且不报错",
			run: func(t *testing.T) {
				artifact := &SemanticGraphArtifact{
					Version: 2, GitSha: "lazy-noedges",
					SymbolsByFile: map[string][]SymbolEntry{"a.ts": {{Name: "run", Kind: "function"}}},
				}
				dir := t.TempDir()
				_, err := SaveSemanticGraphArtifact(dir, "o", "r", "lazy-noedges", artifact)
				require.NoError(t, err)

				lz, err := OpenSemanticGraphArtifactLazy(dir, "o", "r", "lazy-noedges")
				require.NoError(t, err)
				defer func() { require.NoError(t, lz.Close()) }()

				got, err := lz.CallEdges()
				require.NoError(t, err)
				assert.Empty(t, got)
			},
		},
		{
			name: "老 v2 文件走旧路径（双读兼容）",
			run: func(t *testing.T) {
				artifact := &SemanticGraphArtifact{Version: 2, GitSha: "legacy1", SymbolsByFile: map[string][]SymbolEntry{"a.ts": {{Name: "f"}}}}
				dir := t.TempDir()
				path := filepath.Join(dir, "o", "r", "legacy1.json")
				require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
				raw, err := json.Marshal(artifact)
				require.NoError(t, err)
				require.NoError(t, os.WriteFile(path, raw, 0o644))

				got, err := LoadSemanticGraphArtifact(dir, "o", "r", "legacy1")
				require.NoError(t, err)
				assert.Equal(t, artifact.SymbolsByFile, got.SymbolsByFile)
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, tt.run)
	}
}

func TestGroundingIndexLazyEquivalence(t *testing.T) {
	artifact := &SemanticGraphArtifact{
		Version: 2, GitSha: "grdeq1",
		Nodes: []SemanticGraphArtifactNode{
			{Path: "src/a.ts"}, {Path: "src/b.py"}, {Path: "docs/x.md"},
		},
		SymbolsByFile: map[string][]SymbolEntry{
			"src/a.ts": {{Name: "alpha", Kind: "function", Exported: true}},
			"src/b.py": {{Name: "beta"}},
		},
	}
	dir := t.TempDir()
	_, err := SaveSemanticGraphArtifact(dir, "o", "r", "grdeq1", artifact)
	require.NoError(t, err)

	full, err := LoadSemanticGraphArtifact(dir, "o", "r", "grdeq1")
	require.NoError(t, err)
	wantPaths := map[string]bool{}
	for _, n := range full.Nodes {
		wantPaths[n.Path] = true
	}

	lz, err := OpenSemanticGraphArtifactLazy(dir, "o", "r", "grdeq1")
	require.NoError(t, err)
	defer lz.Close()

	gotPaths, err := lz.Paths()
	require.NoError(t, err)
	gotPathSet := map[string]bool{}
	for _, p := range gotPaths {
		gotPathSet[p] = true
	}
	assert.Equal(t, wantPaths, gotPathSet, "paths 集必须一致")

	for _, f := range lz.Files() {
		got, err := lz.SymbolsForFile(f)
		require.NoError(t, err)
		assert.Equal(t, full.SymbolsByFile[f], got, "文件 %s 符号必须一致", f)
	}
	assert.NotContains(t, lz.Files(), "docs/x.md")
	assert.Contains(t, gotPathSet, "docs/x.md")
}
