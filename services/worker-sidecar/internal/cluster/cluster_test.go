package cluster

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func makeTestIngestPatterns(t *testing.T) *IngestPatterns {
	t.Helper()
	patterns, err := LoadIngestPatterns("")
	require.NoError(t, err)
	require.NotNil(t, patterns)
	return patterns
}

func TestMatchModuleFiles(t *testing.T) {
	patterns := makeTestIngestPatterns(t)

	tests := []struct {
		name        string
		nodes       []GitNode
		directories []string
		wantFiles   []string
	}{
		{
			name: "entrypoint files sorted first then alphabetical",
			nodes: []GitNode{
				{Path: "src/utils.ts", Type: "blob"},
				{Path: "src/index.ts", Type: "blob"},
				{Path: "src/core.ts", Type: "blob"},
				{Path: "src/main.ts", Type: "blob"},
			},
			directories: []string{"src"},
			wantFiles: []string{
				"src/index.ts",
				"src/main.ts",
				"src/core.ts",
				"src/utils.ts",
			},
		},
		{
			name: "filters non-content files, dirs, and binary extensions",
			nodes: []GitNode{
				{Path: "src/main.ts", Type: "blob"},
				{Path: "src/image.png", Type: "blob"},
				{Path: "src/LICENSE", Type: "blob"},
				{Path: "src/node_modules/dep.js", Type: "blob"},
				{Path: "src/.git/config", Type: "blob"},
				{Path: "src/docs/guide.md", Type: "blob"},
			},
			directories: []string{"src/"},
			wantFiles: []string{
				"src/main.ts",
				"src/docs/guide.md",
			},
		},
		{
			name: "empty directory slice matches root files only",
			nodes: []GitNode{
				{Path: "README.md", Type: "blob"},
				{Path: "src/index.ts", Type: "blob"},
				{Path: "package.json", Type: "blob"},
				{Path: "main.go", Type: "blob"},
			},
			directories: []string{},
			wantFiles: []string{
				"main.go",
				"README.md",
			},
		},
		{
			name: "backslashes and slashes normalization in directories",
			nodes: []GitNode{
				{Path: "src/core/engine.ts", Type: "blob"},
				{Path: "src/utils/math.ts", Type: "blob"},
			},
			directories: []string{"src\\core\\", "src/utils"},
			wantFiles: []string{
				"src/core/engine.ts",
				"src/utils/math.ts",
			},
		},
		{
			name: "ignores directory nodes and handles empty nodes",
			nodes: []GitNode{
				{Path: "src", Type: "tree"},
				{Path: "src/app.ts", Type: "blob"},
			},
			directories: []string{"src"},
			wantFiles: []string{
				"src/app.ts",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := MatchModuleFiles(tt.nodes, tt.directories, patterns)
			assert.Equal(t, tt.wantFiles, got)
		})
	}
}

func TestInferDirectories(t *testing.T) {
	tests := []struct {
		name     string
		files    []string
		wantDirs []string
	}{
		{
			name: "infers top-level dirs correctly",
			files: []string{
				"src/index.ts",
				"src/core/main.ts",
				"lib/utils.ts",
				"README.md",
			},
			wantDirs: []string{"lib/", "src/"},
		},
		{
			name:     "empty file list returns empty slice",
			files:    []string{},
			wantDirs: []string{},
		},
		{
			name: "root level files only produces empty dirs slice",
			files: []string{
				"main.go",
				"go.mod",
			},
			wantDirs: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := InferDirectories(tt.files)
			assert.Equal(t, tt.wantDirs, got)
		})
	}
}

func TestJaccardSimilarity(t *testing.T) {
	tests := []struct {
		name string
		a    []string
		b    []string
		want float64
	}{
		{
			name: "identical sets return 1.0",
			a:    []string{"a.ts", "b.ts"},
			b:    []string{"b.ts", "a.ts"},
			want: 1.0,
		},
		{
			name: "disjoint sets return 0.0",
			a:    []string{"a.ts"},
			b:    []string{"b.ts"},
			want: 0.0,
		},
		{
			name: "partial overlap returns correct ratio",
			a:    []string{"a.ts", "b.ts", "c.ts"},
			b:    []string{"b.ts", "c.ts", "d.ts"},
			want: 2.0 / 4.0,
		},
		{
			name: "empty sets return 0.0",
			a:    []string{},
			b:    []string{"a.ts"},
			want: 0.0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := JaccardSimilarity(tt.a, tt.b)
			assert.InDelta(t, tt.want, got, 0.0001)
		})
	}
}

func TestDiffCodeClusters(t *testing.T) {
	t.Run("preserves chapterNo strictly from old to neu when matched", func(t *testing.T) {
		oldClusters := []ModuleSnapshot{
			{
				TeachingOrder: 1,
				ChapterNo:     42,
				Title:         "Old Module",
				Files:         []string{"src/a.ts", "src/b.ts"},
			},
		}
		newClusters := []ModuleSnapshot{
			{
				TeachingOrder: 2,
				ChapterNo:     99,
				Title:         "New Module",
				Files:         []string{"src/a.ts", "src/b.ts"},
			},
		}

		res := DiffCodeClusters(oldClusters, newClusters)
		require.Len(t, res.Matched, 1)
		assert.Equal(t, 42, res.Matched[0].Neu.ChapterNo)
		assert.Equal(t, 1.0, res.Matched[0].Similarity)
		assert.Empty(t, res.Added)
		assert.Empty(t, res.Removed)
	})

	t.Run("identifies added and removed modules when similarity < threshold", func(t *testing.T) {
		oldClusters := []ModuleSnapshot{
			{
				TeachingOrder: 1,
				ChapterNo:     1,
				Title:         "Removed Module",
				Files:         []string{"src/a.ts", "src/b.ts", "src/c.ts"},
			},
		}
		newClusters := []ModuleSnapshot{
			{
				TeachingOrder: 1,
				ChapterNo:     1,
				Title:         "Added Module",
				Files:         []string{"src/x.ts", "src/y.ts", "src/z.ts"},
			},
		}

		res := DiffCodeClusters(oldClusters, newClusters)
		assert.Empty(t, res.Matched)
		require.Len(t, res.Removed, 1)
		assert.Equal(t, 1, res.Removed[0].TeachingOrder)
		assert.Equal(t, "Removed Module", res.Removed[0].Title)
		require.Len(t, res.Added, 1)
		assert.Equal(t, "Added Module", res.Added[0].Title)
	})
}

func TestRecomputeModuleSnapshots(t *testing.T) {
	patterns := makeTestIngestPatterns(t)

	oldModules := []ModuleSnapshot{
		{
			TeachingOrder: 1,
			ChapterNo:     1,
			Title:         "Core Engine",
			Summary:       "Core logic",
			Directories:   []string{"src/core"},
			Files:         []string{"src/core/engine.ts"},
		},
		{
			TeachingOrder: 2,
			ChapterNo:     2,
			Title:         "Utils",
			Summary:       "Utilities",
			Directories:   []string{"src/utils"},
			Files:         []string{"src/utils/old.ts"},
		},
	}

	nodes := []GitNode{
		{Path: "src/core/engine.ts", Type: "blob"},
		{Path: "src/core/new_feature.ts", Type: "blob"},
		{Path: "other/file.ts", Type: "blob"},
	}

	recomputed := RecomputeModuleSnapshots(oldModules, nodes, patterns)
	require.Len(t, recomputed, 1)
	assert.Equal(t, 1, recomputed[0].TeachingOrder)
	assert.Equal(t, 1, recomputed[0].ChapterNo)
	assert.Equal(t, "Core Engine", recomputed[0].Title)
	assert.Equal(t, []string{"src/core/engine.ts", "src/core/new_feature.ts"}, recomputed[0].Files)
}

func TestGroupModulesByDirectory(t *testing.T) {
	patterns := makeTestIngestPatterns(t)

	nodes := []GitNode{
		{Path: "src/index.ts", Type: "blob"},
		{Path: "lib/math.ts", Type: "blob"},
		{Path: "README.md", Type: "blob"},
		{Path: ".git/config", Type: "blob"},
	}

	snapshots := GroupModulesByDirectory(nodes, patterns)
	require.Len(t, snapshots, 3)

	assert.Equal(t, "src", snapshots[0].Title)
	assert.Equal(t, []string{"src/index.ts"}, snapshots[0].Files)

	assert.Equal(t, "lib", snapshots[1].Title)
	assert.Equal(t, []string{"lib/math.ts"}, snapshots[1].Files)

	assert.Equal(t, "Root", snapshots[2].Title)
	assert.Equal(t, []string{"README.md"}, snapshots[2].Files)
}

func TestBuildModuleSnapshots(t *testing.T) {
	patterns := makeTestIngestPatterns(t)

	modules := []DraftModuleInput{
		{Name: "Backend", Directories: []string{"src/api"}},
		{Name: "Frontend", Directories: []string{"src/ui"}},
	}

	nodes := []GitNode{
		{Path: "src/api/server.ts", Type: "blob"},
		{Path: "src/ui/app.tsx", Type: "blob"},
	}

	snapshots := BuildModuleSnapshots(modules, nodes, patterns)
	require.Len(t, snapshots, 2)
	assert.Equal(t, "Backend", snapshots[0].Title)
	assert.Equal(t, []string{"src/api/server.ts"}, snapshots[0].Files)
	assert.Equal(t, "Frontend", snapshots[1].Title)
	assert.Equal(t, []string{"src/ui/app.tsx"}, snapshots[1].Files)
}

func TestClusterLoadIngestPatternsFailClosed(t *testing.T) {
	t.Run("空路径返回原生预置", func(t *testing.T) {
		p, err := LoadIngestPatterns("")
		require.NoError(t, err)
		require.NotNil(t, p)
		assert.True(t, p.IsCodeFile("main.go"))
		assert.True(t, p.IsDocFile("guide.md"))
	})

	t.Run("显式缺失路径坚决报错", func(t *testing.T) {
		badPath := filepath.Join(t.TempDir(), "nonexistent-patterns.json")
		p, err := LoadIngestPatterns(badPath)
		require.Error(t, err)
		assert.Nil(t, p)
		assert.Contains(t, err.Error(), "[cluster] explicit ingest patterns path")
	})
}
