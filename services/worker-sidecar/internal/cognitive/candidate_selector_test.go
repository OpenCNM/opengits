package cognitive

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func mkBlob(path string) GitNode {
	return GitNode{Path: path, Type: "blob", Size: 100}
}

func TestSelectCandidateFilesForOutlineSourceSovereignty(t *testing.T) {
	patterns := DefaultPatterns()
	require.NotNil(t, patterns)

	t.Run("海量外围 README 不得挤占源码配额", func(t *testing.T) {
		nodes := []GitNode{mkBlob("src/main.ts"), mkBlob("src/util.ts"), mkBlob("src/api.ts"), mkBlob("src/store.ts")}
		nodes = append(nodes, mkBlob("packages/alpha/README.md"), mkBlob("packages/beta/README.md"))
		for i := 0; i < 38; i++ {
			nodes = append(nodes, mkBlob(fmt.Sprintf("vendored/d%02d/pkg/README.md", i)))
		}

		got := SelectCandidateFilesForOutline(nodes, 6, patterns)
		require.Len(t, got, 6)

		codeCount := 0
		readmeCount := 0
		for _, c := range got {
			if !c.IsDoc {
				codeCount++
			} else if isReadmeCandidatePath(c.Path, patterns) {
				readmeCount++
			}
		}
		assert.Equal(t, 4, codeCount, "全部真实源码必须入选，外围 README 不得挤占")
		assert.Equal(t, 2, readmeCount)
		paths := map[string]bool{}
		for _, c := range got {
			paths[c.Path] = true
		}
		assert.True(t, paths["packages/alpha/README.md"], "子树密度最高的主模块 README 应入选")
		assert.True(t, paths["packages/beta/README.md"], "子树密度次高的主模块 README 应入选")
		assert.False(t, paths["vendored/d00/pkg/README.md"], "子树零源码的空壳 README 应垫底出局")
	})

	t.Run("README 总数加帽 min(4, docQuota)", func(t *testing.T) {
		nodes := []GitNode{mkBlob("src/main.ts"), mkBlob("src/util.ts")}
		for i := 0; i < 10; i++ {
			nodes = append(nodes, mkBlob(fmt.Sprintf("m%02d/README.md", i)), mkBlob(fmt.Sprintf("m%02d/code.ts", i)))
		}
		got := SelectCandidateFilesForOutline(nodes, 10, patterns)
		readmeCount := 0
		for _, c := range got {
			if isReadmeCandidatePath(c.Path, patterns) {
				readmeCount++
			}
		}
		assert.LessOrEqual(t, readmeCount, 4, "README 总数不得超过 min(4, docQuota) 帽")
	})

	t.Run("docs-only 仓库文档占满全量不回退", func(t *testing.T) {
		var nodes []GitNode
		for i := 0; i < 20; i++ {
			nodes = append(nodes, mkBlob(fmt.Sprintf("docs/g%02d.md", i)))
		}
		got := SelectCandidateFilesForOutline(nodes, 8, patterns)
		require.Len(t, got, 8)
		for _, c := range got {
			assert.True(t, c.IsDoc)
		}
	})

	t.Run("子树源码密度排序：主模块 README 先于空壳 README", func(t *testing.T) {
		candidates := []CandidateOutlineFile{
			{Path: "shell/pkg/README.md", IsDoc: true, Weight: 25},
			{Path: "core/README.md", IsDoc: true, Weight: 25},
			{Path: "core/engine.ts", IsDoc: false, Weight: 8},
			{Path: "core/state.ts", IsDoc: false, Weight: 8},
			{Path: "core/flow.ts", IsDoc: false, Weight: 8},
			{Path: "src/main.ts", IsDoc: false, Weight: 15},
		}
		got := selectDocPool(candidates[:2], 2, subtreeCodeDensity(candidates), patterns, 4)
		require.Len(t, got, 2)
		assert.Equal(t, "core/README.md", got[0].Path, "子树 3 源码的主模块 README 排第一")
		assert.Equal(t, "shell/pkg/README.md", got[1].Path, "子树 0 源码的空壳 README 垫底")
	})
}

func TestSelectCandidateFilesBelowMaxUnchanged(t *testing.T) {
	patterns := DefaultPatterns()
	nodes := []GitNode{mkBlob("README.md"), mkBlob("src/main.ts"), mkBlob("src/util.ts")}
	got := SelectCandidateFilesForOutline(nodes, 10, patterns)
	require.Len(t, got, 3)
	assert.Equal(t, 1, got[0].Handle)
	assert.Equal(t, "README.md", got[0].Path)
}

func parentDirCounts(paths []string) map[string]int {
	counts := map[string]int{}
	for _, p := range paths {
		dir := "."
		if idx := strings.LastIndex(p, "/"); idx >= 0 {
			dir = p[:idx]
		}
		counts[dir]++
	}
	return counts
}

func selectedPaths(files []CandidateOutlineFile) []string {
	paths := make([]string, 0, len(files))
	for _, c := range files {
		paths = append(paths, c.Path)
	}
	return paths
}

func TestSelectCandidateFilesForOutlineDensityRanking(t *testing.T) {
	t.Helper()
	patterns := DefaultPatterns()
	nodes := []GitNode{
		mkBlob("packages/alpha/README.md"), mkBlob("packages/alpha/src/a1.ts"), mkBlob("packages/alpha/src/a2.ts"),
		mkBlob("packages/beta/README.md"), mkBlob("packages/beta/src/b1.ts"),
		mkBlob("vendored/d00/pkg/README.md"), mkBlob("vendored/d01/pkg/README.md"),
	}
	got := SelectCandidateFilesForOutline(nodes, 6, patterns)
	require.Len(t, got, 5)
	paths := map[string]bool{}
	for _, p := range selectedPaths(got) {
		paths[p] = true
	}
	assert.True(t, paths["packages/alpha/README.md"], "子树 2 源码的主模块 README 应入选")
	assert.True(t, paths["packages/beta/README.md"], "子树 1 源码的主模块 README 应入选")
	assert.False(t, paths["vendored/d00/pkg/README.md"], "子树零源码的空壳 README 应垫底出局")
	assert.False(t, paths["vendored/d01/pkg/README.md"], "子树零源码的空壳 README 应垫底出局")
	for _, code := range []string{"packages/alpha/src/a1.ts", "packages/alpha/src/a2.ts", "packages/beta/src/b1.ts"} {
		assert.True(t, paths[code], "源码不得被文档挤出：%s", code)
	}
}

func TestSelectCandidateFilesForOutlineDocsOnlyDirectoryFairness(t *testing.T) {
	t.Helper()
	patterns := DefaultPatterns()
	tests := []struct {
		name     string
		dirs     map[string]int
		maxFiles int
		want     map[string]int
	}{
		{
			name:     "三目录等量：各占三分之一",
			dirs:     map[string]int{"docs/api": 40, "docs/guide": 40, "docs/blog": 40},
			maxFiles: 60,
			want:     map[string]int{"docs/api": 20, "docs/guide": 20, "docs/blog": 20},
		},
		{
			name:     "悬殊目录：小目录全部入选",
			dirs:     map[string]int{"manual": 100, "faq": 5, "recipes": 5},
			maxFiles: 40,
			want:     map[string]int{"manual": 30, "faq": 5, "recipes": 5},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var nodes []GitNode
			for dir, n := range tt.dirs {
				for i := 0; i < n; i++ {
					nodes = append(nodes, mkBlob(fmt.Sprintf("%s/page-%03d.md", dir, i)))
				}
			}
			got := SelectCandidateFilesForOutline(nodes, tt.maxFiles, patterns)
			require.Len(t, got, tt.maxFiles)
			assert.Equal(t, tt.want, parentDirCounts(selectedPaths(got)))
		})
	}
}

func TestSelectCandidateFilesForOutlineTinyMaxFiles(t *testing.T) {
	t.Helper()
	patterns := DefaultPatterns()
	var nodes []GitNode
	for i := 0; i < 40; i++ {
		nodes = append(nodes, mkBlob(fmt.Sprintf("pkg%d/README.md", i)), mkBlob(fmt.Sprintf("pkg%d/code%d.ts", i, i)))
	}
	tests := []struct {
		maxFiles int
		wantCode int
		wantDoc  int
	}{
		{maxFiles: 1, wantCode: 1, wantDoc: 0},
		{maxFiles: 2, wantCode: 1, wantDoc: 1},
		{maxFiles: 3, wantCode: 2, wantDoc: 1},
		{maxFiles: 4, wantCode: 2, wantDoc: 2},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("maxFiles=%d", tt.maxFiles), func(t *testing.T) {
			got := SelectCandidateFilesForOutline(nodes, tt.maxFiles, patterns)
			code, doc := 0, 0
			for _, c := range got {
				if c.IsDoc {
					doc++
				} else {
					code++
				}
			}
			assert.Equal(t, tt.wantCode, code, "代码入选数")
			assert.Equal(t, tt.wantDoc, doc, "文档入选数")
		})
	}
}
