package rsg

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// bundle 契约锁：编码往返、三护栏回退、生命周期自清理、键一致性、
// 目录卫生（不与 .json 产物候选冲突）。

func sampleSnapshots() []extractionSnapshot {
	return []extractionSnapshot{
		{Key: MakeAstCacheKey(ComputeContentSha("const a=1"), "typescript"),
			Extraction: &FileAstExtraction{
				Symbols:             []SymbolEntry{{Name: "a", Kind: "type", StartLine: 1, EndLine: 1, Exported: true}},
				Imports:             []ImportRecord{{Module: "x", Bindings: []string{"y"}}},
				CallSites:           []CallSite{{Name: "y", Line: 2}},
				ReferencedConstants: []string{"A"},
				RawImports:          []string{"x"},
			}},
		{Key: MakeAstCacheKey(ComputeContentSha("def b():\n  pass"), "python"),
			Extraction: &FileAstExtraction{Symbols: []SymbolEntry{{Name: "b", Kind: "function"}}}},
	}
}

func TestAstBundle(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T)
	}{
		{name: "编码往返逐字段等价", run: func(t *testing.T) {
			enc, err := encodeAstBundle("abc", sampleSnapshots())
			require.NoError(t, err)
			entries, err := decodeAstBundle(enc)
			require.NoError(t, err)
			require.Len(t, entries, 2)
			for _, s := range sampleSnapshots() {
				assert.Equal(t, s.Extraction, entries[s.Key])
			}
		}},
		{name: "护栏：schema 版本不符整包弃用", run: func(t *testing.T) {
			enc, err := encodeAstBundle("abc", sampleSnapshots())
			require.NoError(t, err)
			// 篡改 schemaVer（header JSON 第 3 个字段）
			corrupted := []byte(enc)
			idx := indexOf(corrupted, []byte(`"schemaVer":1`))
			require.NotEqual(t, -1, idx)
			corrupted[idx+len(`"schemaVer":`)] = '9'
			_, err = decodeAstBundle(corrupted)
			require.Error(t, err, "版本不符必须整体弃用")
		}},
		{name: "护栏：截断容器拒绝", run: func(t *testing.T) {
			enc, err := encodeAstBundle("abc", sampleSnapshots())
			require.NoError(t, err)
			_, err = decodeAstBundle(enc[:len(enc)/3])
			require.Error(t, err)
			_, err = decodeAstBundle([]byte("garbage"))
			require.Error(t, err)
		}},
		{name: "护栏：kill switch 禁用预热", run: func(t *testing.T) {
			t.Setenv("RSG_AST_BUNDLE", "0")
			dir := t.TempDir()
			SaveAstBundle(dir, "o", "r", "1111111111111111111111111111111111111111", sampleSnapshots())
			n := WarmAstCacheFromBundle(dir, "o", "r", "1111111111111111111111111111111111111111")
			assert.Equal(t, 0, n)
		}},
		{name: "预热回填与缓存键命中", run: func(t *testing.T) {
			t.Setenv("RSG_AST_BUNDLE", "1")
			old := GetDefaultAstCache()
			fresh := NewAstCache(1024)
			SetDefaultAstCache(fresh)
			t.Cleanup(func() { SetDefaultAstCache(old) })

			dir := t.TempDir()
			sha := "2222222222222222222222222222222222222222"
			SaveAstBundle(dir, "o", "r", sha, sampleSnapshots())
			n := WarmAstCacheFromBundle(dir, "o", "r", sha)
			require.Equal(t, 2, n)

			// 直接以相同内容走提取：应命中缓存（零解析）
			defs := testDefs(t)
			ext := defs.ExtractFileAstWithSha("const a=1", "a.ts", "")
			require.NotNil(t, ext)
			require.Equal(t, int64(1), fresh.Stats().Hits, "预热条目必须被提取路径命中")
		}},
		{name: "生命周期：同仓只保留最新 bundleKeepCount 个", run: func(t *testing.T) {
			dir := t.TempDir()
			repoDir := filepath.Join(dir, "o", "r")
			for i := 0; i < 4; i++ {
				SaveAstBundle(dir, "o", "r", shas[i], sampleSnapshots())
			}
			files, err := os.ReadDir(repoDir)
			require.NoError(t, err)
			count := 0
			for _, f := range files {
				if filepath.Ext(f.Name()) == ".astbundle" {
					count++
				}
			}
			assert.LessOrEqual(t, count, bundleKeepCount, "旧 bundle 应被自清理")
		}},
		{name: "目录卫生：bundle 不以 .json 结尾", run: func(t *testing.T) {
			file, err := astBundlePathFor("dir", "o", "r", shas[0])
			require.NoError(t, err)
			assert.NotContains(t, filepath.Base(file), ".json", "不得进入最新产物候选扫描")
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, tt.run)
	}
}

var shas = [4]string{
	"1111111111111111111111111111111111111111",
	"2222222222222222222222222222222222222222",
	"3333333333333333333333333333333333333333",
	"4444444444444444444444444444444444444444",
}

func indexOf(hay, needle []byte) int {
	for i := 0; i+len(needle) <= len(hay); i++ {
		match := true
		for j := range needle {
			if hay[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

// testDefs 最小语言定义夹具（预热命中测试只需 DetectLanguage + 提取路径）。
func testDefs(t *testing.T) *LanguageDefinitions {
	t.Helper()
	return DefaultLanguageDefinitions()
}

// TestBuildRepoSemanticGraphColdStartEquivalence 冷启动等价锁：真实归档
// 构建两遍（中间换新 AST 缓存模拟重启 + bundle 预热），产物逐字段一致。
func TestBuildRepoSemanticGraphColdStartEquivalence(t *testing.T) {
	archiveRoot := filepath.Join("..", "..", "storage", "repos")
	owner, repo := "tokio-rs", "mini-redis"
	entries, err := os.ReadDir(filepath.Join(archiveRoot, owner, repo))
	if err != nil {
		t.Skip("本地无真实归档（storage/repos 为空）")
	}
	var shas []string
	for _, e := range entries {
		if e.IsDir() && len(e.Name()) == 40 {
			shas = append(shas, e.Name())
		}
	}
	if len(shas) == 0 {
		t.Skip("归档目录无 sha 子目录")
	}
	sha := shas[0]

	defs := DefaultLanguageDefinitions()

	// 归档目录树 → GitNode 清单（与 ingest 扫描同源）
	var nodes []GitNode
	require.True(t, cluster.WalkArchiveTree(archiveRoot, owner, repo, sha, nil, func(n cluster.GitNode) error {
		nodes = append(nodes, n)
		return nil
	}), "归档遍历失败")
	require.NotEmpty(t, nodes)

	graphDir := t.TempDir()
	// 第一遍：正常构建（产物 + bundle 落盘）
	first, err := BuildRepoSemanticGraph(context.Background(), archiveRoot, graphDir, owner, repo, sha, defs, nil, nodes)
	require.NoError(t, err)

	// 模拟重启：换新 AST 缓存（bundle 预热在构建入口自动发生）
	old := GetDefaultAstCache()
	fresh := NewAstCache(DefaultMaxAstCacheEntries)
	SetDefaultAstCache(fresh)
	t.Cleanup(func() { SetDefaultAstCache(old) })

	second, err := BuildRepoSemanticGraph(context.Background(), archiveRoot, graphDir, owner, repo, sha, defs, nil, nodes)
	require.NoError(t, err)
	// 预热必须真实生效：同一归档二次构建，可解析文件应全部命中缓存
	//（零 miss = 冷启动零重解析）
	assert.Zerof(t, fresh.Stats().Misses, "预热未生效：二次构建仍发生缓存 miss（重解析）")

	// GeneratedAt 是构建时刻（时间性字段），等价断言剔除；其余全部逐字段一致
	first.GeneratedAt, second.GeneratedAt = "", ""
	assert.Equal(t, first, second, "冷启动预热后重建的语义图必须与首建逐字段一致")
}
