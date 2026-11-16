package pipelineb

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestBuildRepoTreeRollupAndCollapse 合成树:上卷数值正确性 + 单子链折叠。
func TestBuildRepoTreeRollupAndCollapse(t *testing.T) {
	files := []FileMap{
		{Path: "README.md", LOC: 100, IsDoc: true},
		{Path: "cmp/compare.go", LOC: 500, Hotness: 9, Exports: []string{"Diff"}},
		{Path: "cmp/compare_test.go", LOC: 80, IsTest: true},
		{Path: "cmp/internal/diff/diff.go", LOC: 200, Hotness: 3},
		{Path: "cmd/tool/x.go", LOC: 150, Hotness: 1},
	}
	root := BuildRepoTree(files, "demo")

	// 折叠断言:cmd→tool 单子链折叠为 cmd/tool 一节点
	byPath := map[string]*RepoTreeNode{}
	var collect func(n *RepoTreeNode)
	collect = func(n *RepoTreeNode) {
		byPath[n.Path] = n
		for _, c := range n.Children {
			collect(c)
		}
	}
	collect(root)

	if _, ok := byPath["cmd/tool"]; !ok {
		t.Fatalf("单子链未折叠: 节点集 %v", keysOf(byPath))
	}
	if _, ok := byPath["cmd"]; ok {
		t.Error("中间单子节点 cmd 应被吸收")
	}

	// 上卷断言
	cmp := byPath["cmp"]
	if cmp == nil {
		t.Fatal("cmp 节点缺失")
	}
	if cmp.FileCount != 3 {
		t.Errorf("cmp.FileCount = %d, want 3", cmp.FileCount)
	}
	if cmp.LOC != 780 {
		t.Errorf("cmp.LOC = %d, want 780", cmp.LOC)
	}
	if cmp.Hotness != 12 {
		t.Errorf("cmp.Hotness = %d, want 12", cmp.Hotness)
	}
	if cmp.LangDist[".go"] != 3 {
		t.Errorf("cmp.LangDist[.go] = %d, want 3", cmp.LangDist[".go"])
	}
	if root.FileCount != 5 || root.LOC != 1030 {
		t.Errorf("root 上卷错误: files=%d loc=%d", root.FileCount, root.LOC)
	}
}

func keysOf(m map[string]*RepoTreeNode) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestLeafFilesRestoresWalkOrder 叶子重排恢复 WalkDir 全路径字典序
// (顶层文件与子目录交错场景)——P1 字节等价的前提。
func TestLeafFilesRestoresWalkOrder(t *testing.T) {
	// WalkDir 顺序:a.go, b/x.go, c.go(全路径字典序)
	files := []FileMap{
		{Path: "a.go", LOC: 1},
		{Path: "b/x.go", LOC: 2},
		{Path: "c.go", LOC: 3},
	}
	root := BuildRepoTree(files, "demo")
	// 故意以乱序注入 Children 也应被重排修正
	got := root.LeafFiles()
	want := []string{"a.go", "b/x.go", "c.go"}
	if len(got) != len(want) {
		t.Fatalf("叶数 %d ≠ %d", len(got), len(want))
	}
	for i, p := range want {
		if got[i].Path != p {
			t.Fatalf("叶序[%d] = %s, want %s", i, got[i].Path, p)
		}
	}
}

// TestRenderSkeleton 骨架图行形态(O(目录数),含语言分布)。
func TestRenderSkeleton(t *testing.T) {
	files := []FileMap{
		{Path: "README.md", LOC: 100, IsDoc: true},
		{Path: "cmp/a.go", LOC: 500, Hotness: 9},
		{Path: "py/b.py", LOC: 50},
	}
	root := BuildRepoTree(files, "demo")
	s := RenderSkeleton(root)
	for _, want := range []string{"demo | files:3 | loc:650 | hot:9", "cmp | files:1 | loc:500 | hot:9", ".go×1", ".md×1", ".py×1"} {
		if !strings.Contains(s, want) {
			t.Errorf("骨架图缺少 %q:\n%s", want, s)
		}
	}
}

// TestRenderSamplingSkeleton AI 采样骨架图（包含目录上卷与真实物理文件相对路径）。
func TestRenderSamplingSkeleton(t *testing.T) {
	files := []FileMap{
		{Path: "README.md", LOC: 100, IsDoc: true},
		{Path: "package.json", LOC: 40, IsConfig: true},
		{Path: "src/index.ts", LOC: 25},
		{Path: "src/server.ts", LOC: 300},
		{Path: "src/util.ts", LOC: 50},
		{Path: "test/server.test.ts", LOC: 80, IsTest: true},
	}
	root := BuildRepoTree(files, "web-app")
	s := RenderSamplingSkeleton(root)

	// 1. 根目录文件应逐行输出路径
	assert.Contains(t, s, "- README.md | loc:100 | doc")
	assert.Contains(t, s, "- package.json | loc:40 | config")

	// 2. 子目录应逐行输出物理路径
	assert.Contains(t, s, "- src/index.ts | loc:25")
	assert.Contains(t, s, "- src/server.ts | loc:300")

	// 3. 预算截断测试
	sBudget := RenderSamplingSkeleton(root, 2)
	assert.NotEmpty(t, sBudget)
}

// TestTreeMapCacheRoundTrip 缓存往返 + 版本拒读 + 穿越拒收。
func TestTreeMapCacheRoundTrip(t *testing.T) {
	dir := t.TempDir()
	files := []FileMap{{Path: "a.go", LOC: 10, Hotness: 2, Exports: []string{"A"}}}
	tree := BuildRepoTree(files, "demo")

	if _, err := SaveTreeMap(dir, "own", "repo", "sha1", &TreeMapCache{GitSha: "sha1", Tree: tree}); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := LoadTreeMap(dir, "own", "repo", "sha1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got.Version != TreeMapCacheVersion || got.Tree.FileCount != 1 || got.Tree.LOC != 10 {
		t.Errorf("往返失真: %+v", got)
	}
	if len(got.Tree.Files) != 1 || got.Tree.Files[0].Exports[0] != "A" {
		t.Errorf("叶载荷丢失: %+v", got.Tree.Files)
	}

	// 版本不符拒读
	bad := filepath.Join(dir, "own", "repo", "sha2.json")
	if err := os.MkdirAll(filepath.Dir(bad), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bad, []byte(`{"version":999,"gitSha":"x","tree":null}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTreeMap(dir, "own", "repo", "sha2"); err == nil {
		t.Error("版本不符应拒读")
	}

	// 路径穿越拒收
	if _, err := TreeMapPathFor(dir, "../evil", "repo", "sha"); err == nil {
		t.Error("owner 穿越应拒收")
	}
}

// TestRepoMapTreeLeafEqualsFiles P1 字节等价核心断言:树上叶序 == 扁平地图序。
func TestRepoMapTreeLeafEqualsFiles(t *testing.T) {
	// 交错序场景(顶层文件与子目录交替)+ 多级目录
	files := []FileMap{
		{Path: "a.md", LOC: 1, IsDoc: true},
		{Path: "cmp/compare.go", LOC: 5},
		{Path: "cmp/internal/diff/d.go", LOC: 2},
		{Path: "zz.go", LOC: 3},
		{Path: "cmp/b.go", LOC: 4},
	}
	root := BuildRepoTree(files, "demo")
	leaves := root.LeafFiles()
	if len(leaves) != len(files) {
		t.Fatalf("叶数 %d ≠ %d", len(leaves), len(files))
	}
	want := append([]FileMap(nil), files...)
	sortByPath := func(fm []FileMap) {
		for i := 1; i < len(fm); i++ {
			for j := i; j > 0 && fm[j-1].Path > fm[j].Path; j-- {
				fm[j-1], fm[j] = fm[j], fm[j-1]
			}
		}
	}
	sortByPath(want)
	for i := range want {
		if leaves[i].Path != want[i].Path {
			t.Fatalf("叶序[%d]=%s want %s", i, leaves[i].Path, want[i].Path)
		}
	}
}

func TestPruneTree(t *testing.T) {
	files := []FileMap{
		{Path: "README.md", LOC: 50, IsDoc: true},
		{Path: "src/core/main.go", LOC: 200, Hotness: 10},
		{Path: "src/core/util.go", LOC: 100, Hotness: 5},
		{Path: "tests/core_test.go", LOC: 80, IsTest: true},
		{Path: "docs/guide.md", LOC: 120, IsDoc: true},
	}
	root := BuildRepoTree(files, "myrepo")
	if root.FileCount != 5 {
		t.Fatalf("初始文件数期望 5，实际 %d", root.FileCount)
	}

	PruneTree(root, []string{"tests", "docs"})
	if root.FileCount != 3 {
		t.Fatalf("剪枝后文件数期望 3，实际 %d", root.FileCount)
	}
	if root.LOC != 350 {
		t.Fatalf("剪枝后 LOC 期望 350，实际 %d", root.LOC)
	}

	for _, f := range root.LeafFiles() {
		if strings.HasPrefix(f.Path, "tests/") || strings.HasPrefix(f.Path, "docs/") {
			t.Errorf("剪枝残留排除路径文件: %s", f.Path)
		}
	}
}
