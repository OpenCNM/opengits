package scout

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 🧪 Table-Driven: naturalDirOrder 自然数字序与大小写不敏感比对
func TestDirTreeBuilder_NaturalOrder(t *testing.T) {
	tests := []struct {
		name     string
		a        string
		b        string
		expected int // -1: a < b, 0: a == b, 1: a > b
	}{
		{
			name:     "chapter numeric comparison: 1 < 2",
			a:        "chapter-1",
			b:        "chapter-2",
			expected: -1,
		},
		{
			name:     "chapter numeric comparison: 2 < 10 (natural sort beats lexicographic)",
			a:        "chapter-2",
			b:        "chapter-10",
			expected: -1,
		},
		{
			name:     "chapter numeric comparison: 10 > 2",
			a:        "chapter-10",
			b:        "chapter-2",
			expected: 1,
		},
		{
			name:     "version numeric comparison: v1.2.0 < v1.10.0",
			a:        "v1.2.0",
			b:        "v1.10.0",
			expected: -1,
		},
		{
			name:     "case insensitive equality",
			a:        "README",
			b:        "readme",
			expected: 0,
		},
		{
			name:     "identical strings",
			a:        "docs",
			b:        "docs",
			expected: 0,
		},
		{
			name:     "alphabetical ordering",
			a:        "api",
			b:        "guide",
			expected: -1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := naturalDirOrder(tt.a, tt.b)
			if tt.expected < 0 {
				assert.Less(t, res, 0)
			} else if tt.expected > 0 {
				assert.Greater(t, res, 0)
			} else {
				assert.Equal(t, 0, res)
			}
		})
	}
}

// 🧪 Table-Driven: DirTreeBuilder.Build 基础与层级构建测试
func TestDirTreeBuilder_Build(t *testing.T) {
	countAllNodes := func(nodes []DirTreeNode) int {
		total := 0
		var walk func([]DirTreeNode)
		walk = func(list []DirTreeNode) {
			for _, n := range list {
				total++
				walk(n.Children)
			}
		}
		walk(nodes)
		return total
	}

	tests := []struct {
		name         string
		maxDepth     int
		maxNodes     int
		nodes        []GitNode
		verify       func(t *testing.T, tree []DirTreeNode)
	}{
		{
			name:     "empty input returns empty tree",
			maxDepth: 4,
			maxNodes: 100,
			nodes:    []GitNode{},
			verify: func(t *testing.T, tree []DirTreeNode) {
				assert.Empty(t, tree)
			},
		},
		{
			name:     "single level hierarchy with md and non-md blobs",
			maxDepth: 4,
			maxNodes: 100,
			nodes: []GitNode{
				{Path: "src", Type: "tree"},
				{Path: "src/main.go", Type: "blob"},
				{Path: "docs", Type: "tree"},
				{Path: "docs/index.md", Type: "blob"},
				{Path: "docs/readme.mdx", Type: "blob"},
			},
			verify: func(t *testing.T, tree []DirTreeNode) {
				require.Len(t, tree, 2)
				// docs comes before src alphabetically
				assert.Equal(t, "docs", tree[0].Name)
				assert.Equal(t, "docs/", tree[0].Path)
				assert.Equal(t, 2, tree[0].MdCount)
				assert.Equal(t, 1, tree[0].Depth)

				assert.Equal(t, "src", tree[1].Name)
				assert.Equal(t, "src/", tree[1].Path)
				assert.Equal(t, 0, tree[1].MdCount)
				assert.Equal(t, 1, tree[1].CodeCount)
				assert.Equal(t, "go", tree[1].PrimaryLang)
				assert.Equal(t, []string{"main.go"}, tree[1].KeyFiles)
			},
		},
		{
			name:     "multi level hierarchy with maxDepth limitation",
			maxDepth: 2,
			maxNodes: 100,
			nodes: []GitNode{
				{Path: "a", Type: "tree"},
				{Path: "a/b", Type: "tree"},
				{Path: "a/b/c", Type: "tree"},
				{Path: "a/b/c/deep.md", Type: "blob"},
				{Path: "a/b/mid.md", Type: "blob"},
				{Path: "a/root.md", Type: "blob"},
			},
			verify: func(t *testing.T, tree []DirTreeNode) {
				require.Len(t, tree, 1)
				assert.Equal(t, "a", tree[0].Name)
				assert.Equal(t, 1, tree[0].Depth)
				// Depth 2 is allowed (a/b), but depth 3 (a/b/c) is omitted due to maxDepth=2
				require.Len(t, tree[0].Children, 1)
				assert.Equal(t, "b", tree[0].Children[0].Name)
				assert.Equal(t, 2, tree[0].Children[0].Depth)
				assert.Empty(t, tree[0].Children[0].Children)
			},
		},
		{
			name:     "budget pruning drops low-priority branches when nodes exceed budget",
			maxDepth: 4,
			maxNodes: 5,
			nodes: func() []GitNode {
				var list []GitNode
				for i := 1; i <= 20; i++ {
					dir := fmt.Sprintf("pkg%02d", i)
					list = append(list, GitNode{Path: dir, Type: "tree"})
					if i <= 3 {
						list = append(list, GitNode{Path: fmt.Sprintf("%s/guide.md", dir), Type: "blob"})
					}
				}
				return list
			}(),
			verify: func(t *testing.T, tree []DirTreeNode) {
				total := countAllNodes(tree)
				assert.LessOrEqual(t, total, 5)
				// Dirs with mdCount should be prioritized in keeping
				mdDirsKept := 0
				for _, n := range tree {
					if n.MdCount > 0 {
						mdDirsKept++
					}
				}
				assert.GreaterOrEqual(t, mdDirsKept, 3)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			builder := NewDirTreeBuilder(tt.maxDepth, tt.maxNodes)
			require.NotNil(t, builder)
			tree := builder.Build(tt.nodes)
			tt.verify(t, tree)
		})
	}
}

// 🧪 Table-Driven: TestDirTreeBuilder_CodeStatsAndKeyFiles 验证代码物理特征提取与关键文件选样
func TestDirTreeBuilder_CodeStatsAndKeyFiles(t *testing.T) {
	tests := []struct {
		name     string
		nodes    []GitNode
		maxDepth int
		verify   func(t *testing.T, tree []DirTreeNode)
	}{
		{
			name: "micrograd repository structure: pure python codebase with test dir",
			maxDepth: 4,
			nodes: []GitNode{
				{Path: "micrograd", Type: "tree"},
				{Path: "micrograd/engine.py", Type: "blob"},
				{Path: "micrograd/nn.py", Type: "blob"},
				{Path: "micrograd/__init__.py", Type: "blob"},
				{Path: "test", Type: "tree"},
				{Path: "test/test_engine.py", Type: "blob"},
			},
			verify: func(t *testing.T, tree []DirTreeNode) {
				require.Len(t, tree, 2)

				// micrograd/ comes before test/ alphabetically
				mg := tree[0]
				assert.Equal(t, "micrograd/", mg.Path)
				assert.Equal(t, 0, mg.MdCount)
				assert.Equal(t, 3, mg.CodeCount)
				assert.Equal(t, "python", mg.PrimaryLang)
				// Non-boilerplate (engine.py, nn.py) come before __init__.py
				assert.Equal(t, []string{"engine.py", "nn.py", "__init__.py"}, mg.KeyFiles)

				testNode := tree[1]
				assert.Equal(t, "test/", testNode.Path)
				assert.Equal(t, 0, testNode.MdCount)
				assert.Equal(t, 1, testNode.CodeCount)
				assert.Equal(t, "python", testNode.PrimaryLang)
				assert.Equal(t, []string{"test_engine.py"}, testNode.KeyFiles)
			},
		},
		{
			name: "keyFiles candidate prioritization: filters out tests and boilerplate when alternatives exist",
			maxDepth: 4,
			nodes: []GitNode{
				{Path: "src", Type: "tree"},
				{Path: "src/calc.test.ts", Type: "blob"},
				{Path: "src/index.ts", Type: "blob"},
				{Path: "src/calc.ts", Type: "blob"},
				{Path: "src/main.ts", Type: "blob"},
				{Path: "src/types.ts", Type: "blob"},
			},
			verify: func(t *testing.T, tree []DirTreeNode) {
				require.Len(t, tree, 1)
				srcNode := tree[0]
				assert.Equal(t, "src/", srcNode.Path)
				assert.Equal(t, 5, srcNode.CodeCount)
				assert.Equal(t, "typescript", srcNode.PrimaryLang)
				// Up to 3 keyFiles, test and boilerplate excluded because 3 substantive files exist
				assert.Equal(t, []string{"calc.ts", "main.ts", "types.ts"}, srcNode.KeyFiles)
			},
		},
		{
			name: "pure documentation directory has zero codeCount and empty keyFiles",
			maxDepth: 4,
			nodes: []GitNode{
				{Path: "docs", Type: "tree"},
				{Path: "docs/index.md", Type: "blob"},
				{Path: "docs/architecture.md", Type: "blob"},
			},
			verify: func(t *testing.T, tree []DirTreeNode) {
				require.Len(t, tree, 1)
				docsNode := tree[0]
				assert.Equal(t, "docs/", docsNode.Path)
				assert.Equal(t, 2, docsNode.MdCount)
				assert.Equal(t, 0, docsNode.CodeCount)
				assert.Empty(t, docsNode.PrimaryLang)
				assert.Empty(t, docsNode.KeyFiles)
			},
		},
		{
			name: "hierarchical inheritance: ancestor directory collects code stats from subdirectories",
			maxDepth: 4,
			nodes: []GitNode{
				{Path: "pkg", Type: "tree"},
				{Path: "pkg/algo", Type: "tree"},
				{Path: "pkg/algo/graph.go", Type: "blob"},
				{Path: "pkg/algo/search.go", Type: "blob"},
			},
			verify: func(t *testing.T, tree []DirTreeNode) {
				require.Len(t, tree, 1)
				pkgNode := tree[0]
				assert.Equal(t, "pkg/", pkgNode.Path)
				assert.Equal(t, 2, pkgNode.CodeCount)
				assert.Equal(t, "go", pkgNode.PrimaryLang)
				assert.Equal(t, []string{"graph.go", "search.go"}, pkgNode.KeyFiles)

				require.Len(t, pkgNode.Children, 1)
				algoNode := pkgNode.Children[0]
				assert.Equal(t, "pkg/algo/", algoNode.Path)
				assert.Equal(t, 2, algoNode.CodeCount)
				assert.Equal(t, "go", algoNode.PrimaryLang)
				assert.Equal(t, []string{"graph.go", "search.go"}, algoNode.KeyFiles)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			builder := NewDirTreeBuilder(tt.maxDepth, DirTreeMaxNodes)
			require.NotNil(t, builder)
			tree := builder.Build(tt.nodes)
			tt.verify(t, tree)
		})
	}
}
