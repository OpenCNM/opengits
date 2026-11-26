package pipelineb

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildRepoTreeRollupAndCollapse(t *testing.T) {
	files := []FileMap{
		{Path: "README.md", LOC: 100, IsDoc: true},
		{Path: "cmp/compare.go", LOC: 500, Hotness: 9, Exports: []string{"Diff"}},
		{Path: "cmp/compare_test.go", LOC: 80, IsTest: true},
		{Path: "cmp/internal/diff/diff.go", LOC: 200, Hotness: 3},
		{Path: "cmd/tool/x.go", LOC: 150, Hotness: 1},
	}
	root := BuildRepoTree(files, "demo")

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

func TestLeafFilesRestoresWalkOrder(t *testing.T) {
	files := []FileMap{
		{Path: "a.go", LOC: 1},
		{Path: "b/x.go", LOC: 2},
		{Path: "c.go", LOC: 3},
	}
	root := BuildRepoTree(files, "demo")
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

	assert.Contains(t, s, "- README.md | loc:100 | doc")
	assert.Contains(t, s, "- package.json | loc:40 | config")

	assert.Contains(t, s, "- src/index.ts | loc:25")
	assert.Contains(t, s, "- src/server.ts | loc:300")

	sBudget := RenderSamplingSkeleton(root, 2)
	assert.NotEmpty(t, sBudget)
}

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

	if _, err := TreeMapPathFor(dir, "../evil", "repo", "sha"); err == nil {
		t.Error("owner 穿越应拒收")
	}
}

func TestRepoMapTreeLeafEqualsFiles(t *testing.T) {
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

func newThematicRichRepo(t *testing.T) *RepoTreeNode {
	t.Helper()
	files := []FileMap{
		{Path: "README.md", LOC: 100, IsDoc: true},
		{Path: "package.json", LOC: 40, IsConfig: true},
		{Path: "src/engine.go", LOC: 300, Hotness: 9, Exports: []string{"Engine", "Run"}, Layer: LayerPipeline},
		{Path: "src/util.go", LOC: 120, Hotness: 5,
			Exports: []string{"E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10"}, Layer: LayerFoundation},
		{Path: "src/aaa.go", LOC: 100, Hotness: 5, Exports: []string{"X", "Y"}},
		{Path: "src/bbb.go", LOC: 500, Hotness: 5, Exports: []string{"Z"}},
		{Path: "src/ccc.go", LOC: 90, Hotness: 5, Exports: []string{"C1"}},
		{Path: "src/ddd.go", LOC: 90, Hotness: 5, Exports: []string{"D1"}, Layer: TopologicalLayer(99)},
		{Path: "src/legacy.go", LOC: 400},
		{Path: "src/engine_test.go", LOC: 60, IsTest: true},
		{Path: "cli/main.go", LOC: 200, Hotness: 2, Exports: []string{"Main"}, Layer: LayerInterface},
		{Path: "notes.md", LOC: 50, IsDoc: true},
	}
	return BuildRepoTree(files, "rich")
}

func newThematicSparseRepo(t *testing.T) *RepoTreeNode {
	t.Helper()
	files := []FileMap{
		{Path: "main.go", LOC: 10},
		{Path: "a/one.go", LOC: 300},
		{Path: "a/two.go", LOC: 200},
		{Path: "b/three.go", LOC: 100},
		{Path: "b/four.go", LOC: 50},
		{Path: "readme.md", LOC: 20, IsDoc: true},
	}
	return BuildRepoTree(files, "sparse")
}

func newSubtreeFilesRepo(t *testing.T) *RepoTreeNode {
	t.Helper()
	files := []FileMap{
		{Path: "root_loose.go", LOC: 40, Hotness: 1, Exports: []string{"L"}},
		{Path: "src/api.go", LOC: 100, Hotness: 8, Exports: []string{"API"}},
		{Path: "src/api_test.go", LOC: 80, IsTest: true},
		{Path: "src/big.md", LOC: 999, IsDoc: true},
		{Path: "src/core/engine.go", LOC: 200, Hotness: 5, Exports: []string{"Engine"}},
		{Path: "src/core/util.go", LOC: 150, Exports: []string{"Util"}},
		{Path: "cli/main.go", LOC: 60, Hotness: 3, Exports: []string{"Main"}},
	}
	return BuildRepoTree(files, "demo")
}

func TestRenderThematicSymbolIndex(t *testing.T) {
	root := newThematicRichRepo(t)
	s := RenderThematicSkeleton(root, 0)

	require.True(t, strings.HasPrefix(s, RenderSkeleton(root)), "第一段必须原样复用 RenderSkeleton:\n%s", s)

	assert.NotContains(t, s, "代表性文件清单")
	assert.Contains(t, s, "=== 定向符号索引(高信噪比 AST 提取文件) ===")

	wantLines := []string{
		"src/engine.go | layer:pipeline | hot:9 | exports:Engine,Run",
		"src/util.go | layer:foundation | hot:5 | exports:E1,E2,E3,E4,E5,E6,E7,E8",
		"src/aaa.go | layer:foundation | hot:5 | exports:X,Y",
		"src/bbb.go | layer:foundation | hot:5 | exports:Z",
		"src/ccc.go | layer:foundation | hot:5 | exports:C1",
		"src/ddd.go | hot:5 | exports:D1",
		"cli/main.go | layer:interface | hot:2 | exports:Main",
	}
	offset := strings.Index(s, "定向符号索引")
	require.GreaterOrEqual(t, offset, 0)
	section := s[offset:]
	pos := -1
	for i, want := range wantLines {
		next := strings.Index(section, want+"\n")
		require.GreaterOrEqual(t, next, pos, "符号索引行[%d]缺失或行序错乱:\n%s", i, s)
		pos = next
	}
	assert.Equal(t, len(wantLines), strings.Count(section, " | exports:"), "符号索引行数不符:\n%s", section)
}

func TestRenderThematicSkeletonBudget(t *testing.T) {
	root := newThematicRichRepo(t)
	s := RenderThematicSkeleton(root, 3)
	offset := strings.Index(s, "定向符号索引")
	require.GreaterOrEqual(t, offset, 0)
	section := s[offset:]
	assert.Equal(t, 3, strings.Count(section, " | exports:"), "maxFiles 截断失效:\n%s", section)
	assert.Contains(t, section, "src/engine.go | layer:pipeline | hot:9 | exports:Engine,Run\n")
	assert.Contains(t, section, "src/util.go | layer:foundation | hot:5 | exports:E1,E2,E3,E4,E5,E6,E7,E8\n")
	assert.Contains(t, section, "src/aaa.go | layer:foundation | hot:5 | exports:X,Y\n")
	assert.NotContains(t, section, "cli/main.go")
}

func TestRenderThematicSparseFallback(t *testing.T) {
	root := newThematicSparseRepo(t)
	s := RenderThematicSkeleton(root, 0)

	assert.NotContains(t, s, "定向符号索引")
	assert.Contains(t, s, "=== 代表性文件清单(未提取符号,按分区配额轮转) ===")
	require.True(t, strings.HasPrefix(s, RenderSkeleton(root)), "第一段物理骨架必须原样前缀:\n%s", s)

	want := []string{
		"readme.md | loc:20",
		"a/one.go | loc:300",
		"b/three.go | loc:100",
		"main.go | loc:10",
		"a/two.go | loc:200",
		"b/four.go | loc:50",
	}
	offset := strings.Index(s, "代表性文件清单")
	require.GreaterOrEqual(t, offset, 0)
	section := s[offset:]
	pos := -1
	for i, w := range want {
		next := strings.Index(section, w+"\n")
		require.GreaterOrEqual(t, next, pos, "兜底轮转行[%d]缺失或行序错乱:\n%s", i, s)
		pos = next
	}
	assert.Equal(t, len(want), strings.Count(section, " | loc:"), "兜底行数不符:\n%s", section)

	s3 := RenderThematicSkeleton(root, 3)
	off3 := strings.Index(s3, "代表性文件清单")
	require.GreaterOrEqual(t, off3, 0)
	assert.Equal(t, 3, strings.Count(s3[off3:], " | loc:"), "兜底段预算截断失效:\n%s", s3[off3:])
	assert.Contains(t, s3[off3:], "readme.md | loc:20\n")
	assert.Contains(t, s3[off3:], "a/one.go | loc:300\n")
	assert.Contains(t, s3[off3:], "b/three.go | loc:100\n")
}

func TestHasSparseAstSymbols(t *testing.T) {
	mk := func(fm ...FileMap) *RepoTreeNode { return BuildRepoTree(fm, "tiny") }
	tests := []struct {
		name string
		root *RepoTreeNode
		want bool
	}{
		{"空仓(分母 0)", mk(), true},
		{"全测试配置(分母 0)", mk(
			FileMap{Path: "a_test.go", IsTest: true},
			FileMap{Path: "cfg.json", IsConfig: true},
		), true},
		{"零符号代码仓", mk(
			FileMap{Path: "a.go"},
			FileMap{Path: "b.go"},
			FileMap{Path: "c.go"},
		), true},
		{"恰好阈值 1/10(严格小于不触发)", mk(
			FileMap{Path: "hit.go", Exports: []string{"H"}},
			FileMap{Path: "m1.go"}, FileMap{Path: "m2.go"}, FileMap{Path: "m3.go"},
			FileMap{Path: "m4.go"}, FileMap{Path: "m5.go"}, FileMap{Path: "m6.go"},
			FileMap{Path: "m7.go"}, FileMap{Path: "m8.go"}, FileMap{Path: "m9.go"},
		), false},
		{"低于阈值 1/11", mk(
			FileMap{Path: "hit.go", Exports: []string{"H"}},
			FileMap{Path: "m1.go"}, FileMap{Path: "m2.go"}, FileMap{Path: "m3.go"},
			FileMap{Path: "m4.go"}, FileMap{Path: "m5.go"}, FileMap{Path: "m6.go"},
			FileMap{Path: "m7.go"}, FileMap{Path: "m8.go"}, FileMap{Path: "m9.go"},
			FileMap{Path: "m10.go"},
		), true},
		{"测试文件不计入分母", mk(
			FileMap{Path: "hit.go", Exports: []string{"H"}},
			FileMap{Path: "m1.go"}, FileMap{Path: "m2.go"}, FileMap{Path: "m3.go"},
			FileMap{Path: "m4.go"}, FileMap{Path: "m5.go"}, FileMap{Path: "m6.go"},
			FileMap{Path: "m7.go"}, FileMap{Path: "m8.go"}, FileMap{Path: "m9.go"},
			FileMap{Path: "t1_test.go", IsTest: true}, FileMap{Path: "t2_test.go", IsTest: true},
			FileMap{Path: "t3_test.go", IsTest: true}, FileMap{Path: "t4_test.go", IsTest: true},
			FileMap{Path: "t5_test.go", IsTest: true}, FileMap{Path: "t6_test.go", IsTest: true},
			FileMap{Path: "t7_test.go", IsTest: true}, FileMap{Path: "t8_test.go", IsTest: true},
			FileMap{Path: "t9_test.go", IsTest: true}, FileMap{Path: "t10_test.go", IsTest: true},
			FileMap{Path: "t11_test.go", IsTest: true}, FileMap{Path: "t12_test.go", IsTest: true},
			FileMap{Path: "t13_test.go", IsTest: true}, FileMap{Path: "t14_test.go", IsTest: true},
			FileMap{Path: "t15_test.go", IsTest: true}, FileMap{Path: "t16_test.go", IsTest: true},
			FileMap{Path: "t17_test.go", IsTest: true}, FileMap{Path: "t18_test.go", IsTest: true},
			FileMap{Path: "t19_test.go", IsTest: true}, FileMap{Path: "t20_test.go", IsTest: true},
		), false},
		{"全符号仓不稀疏", mk(
			FileMap{Path: "a.go", Exports: []string{"A"}},
			FileMap{Path: "b.go", Exports: []string{"B"}},
		), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, HasSparseAstSymbols(tt.root), "case=%s", tt.name)
		})
	}
}

func TestRenderSubtreeSkeletonWithFiles(t *testing.T) {
	root := newSubtreeFilesRepo(t)
	s := RenderSubtreeSkeletonWithFiles(root, 1, 2)
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")

	wantPrefixes := []string{
		"demo | files:7",
		"  - root_loose.go | loc:40",
		"  cli | files:1",
		"    - cli/main.go | loc:60",
		"  src | files:5",
		"    - src/api.go | loc:100",
		"    - src/big.md | loc:999",
	}
	require.Len(t, lines, len(wantPrefixes), "行数不符:\n%s", s)
	for i, want := range wantPrefixes {
		assert.True(t, strings.HasPrefix(lines[i], want), "行[%d]=%q want 前缀 %q\n%s", i, lines[i], want, s)
	}

	assert.NotContains(t, s, "core | files:2")
	assert.NotContains(t, s, "engine.go")

	s2 := RenderSubtreeSkeletonWithFiles(root, 2, 1)
	assert.Contains(t, s2, "core | files:2")
	assert.Contains(t, s2, "      - src/core/engine.go | loc:200")

	s1 := RenderSubtreeSkeletonWithFiles(root, 1, 1)
	off := strings.Index(s1, "src | files:5")
	require.GreaterOrEqual(t, off, 0)
	assert.Equal(t, 0, strings.Count(s1[off:], "- src/big.md"), "budget=1 不应出现第二文件行:\n%s", s1)

	s0 := RenderSubtreeSkeletonWithFiles(root, 1, 0)
	assert.Equal(t, RenderSubtreeSkeleton(root, 1), s0, "budget=0 应与纯目录骨架字节等价")
}

func TestRenderSkeletonRegression(t *testing.T) {
	files := []FileMap{
		{Path: "README.md", LOC: 100, IsDoc: true},
		{Path: "cmp/compare.go", LOC: 500, Hotness: 9, Exports: []string{"Diff"}},
		{Path: "cmp/compare_test.go", LOC: 80, IsTest: true},
		{Path: "cmp/internal/diff/diff.go", LOC: 200, Hotness: 3},
		{Path: "cmd/tool/x.go", LOC: 150, Hotness: 1},
	}
	root := BuildRepoTree(files, "demo")
	want := "demo | files:5 | loc:1030 | hot:13 | .go×4 .md×1\n" +
		"  cmd/tool | files:1 | loc:150 | hot:1 | .go×1\n" +
		"  cmp | files:3 | loc:780 | hot:12 | .go×3\n"
	assert.Equal(t, want, RenderSkeleton(root))
}
