package ingest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─────────────────────────────────────────────────────────────
// 失效封闭回归（346 准则公理 5）：
// - readLocalArchiveFile：IO 错误与「文件真实为空」严格区分；
// - 占位符 "Content not found." 永不入库（源级 tripwire）；
// - 测试目录/文件不入正典（附页收集 + 文本画像过滤双闸）。
// ─────────────────────────────────────────────────────────────

// TestReadLocalArchiveFileFailClosed 归档读取的错误/空文件二义性消除。
func TestReadLocalArchiveFileFailClosed(t *testing.T) {
	root := t.TempDir()
	owner, repo, sha := "octo", "kit", "abc123"
	dir := filepath.Join(root, owner, repo, sha)
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "docs"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "docs", "intro.md"), []byte("# Intro"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "docs", "empty.md"), nil, 0o644))

	tests := []struct {
		name    string
		path    string
		setup   func(t *testing.T)
		wantErr bool
		wantVal string
	}{
		{name: "正常读取返回原文", path: "docs/intro.md", wantVal: "# Intro"},
		{name: "真实空文件返回空串无错误", path: "docs/empty.md", wantVal: ""},
		{name: "文件缺失显式报错", path: "docs/missing.md", wantErr: true},
		{name: "路径穿越显式报错", path: "../../../secret.txt", wantErr: true},
		{name: "空路径参数显式报错", path: "", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := readLocalArchiveFile(root, owner, repo, sha, tt.path)
			if tt.wantErr {
				require.Error(t, err)
				assert.Empty(t, got)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.wantVal, got)
		})
	}

	t.Run("归档根缺失显式报错", func(t *testing.T) {
		_, err := readLocalArchiveFile(filepath.Join(root, "nowhere"), owner, repo, sha, "docs/intro.md")
		require.Error(t, err)
	})
}

// TestPlaceholderNeverPersisted 源级 tripwire：ingest 生产代码中占位符
// 字面量不得回潮（一旦出现即意味着「读取失败伪装成正文」的伪完工路径复活）。
func TestPlaceholderNeverPersisted(t *testing.T) {
	for _, file := range []string{"commit.go", "store_pg.go", "store.go", "ladder.go"} {
		t.Run(file, func(t *testing.T) {
			raw, err := os.ReadFile(file)
			require.NoError(t, err)
			assert.NotContains(t, string(raw), "Content not found.",
				"占位符直存路径回潮：读取失败必须显式报错/跳过，严禁伪装成正文入库")
		})
	}
}

// TestBuildCodeRepoPlanExcludesTestDocs 附页收编闸：测试目录下的 markdown
// 不是教学认知单元，严禁 PROCESSED 直存进正典。
func TestBuildCodeRepoPlanExcludesTestDocs(t *testing.T) {
	patterns := DefaultPatterns()
	require.NotNil(t, patterns)

	snapshots := []ModuleSnapshot{{
		TeachingOrder: 1, ChapterNo: 1, Title: "Core",
		Files: []string{"src/main.go"},
	}}
	nodes := []GitNode{
		{Path: "src", Type: "tree"},
		{Path: "src/main.go", Type: "blob"},
		{Path: "docs/guide.md", Type: "blob"},
		{Path: "tests", Type: "tree"},
		{Path: "tests/README.md", Type: "blob"},
		{Path: "pkg/util_spec.md", Type: "blob"},
	}

	plan := buildCodeRepoPlan(snapshots, nodes, patterns, "octo", "kit", "")
	require.NotNil(t, plan)

	seen := map[string]bool{}
	for _, doc := range plan.AppendixDocs {
		seen[doc.Path] = true
	}
	assert.True(t, seen["docs/guide.md"], "普通文档应收编为附页")
	assert.False(t, seen["tests/README.md"], "测试目录 markdown 不得入正典")
	assert.False(t, seen["pkg/util_spec.md"], "spec 测试文件不得入正典")
}

// TestFilterNodesByProfileRejectsTestFiles 文本路径画像过滤闸：测试文件
// 不得进入规则树兜底章节。
func TestFilterNodesByProfileRejectsTestFiles(t *testing.T) {
	patterns := DefaultPatterns()
	require.NotNil(t, patterns)

	nodes := []GitNode{
		{Path: "docs", Type: "tree"},
		{Path: "docs/getting-started.md", Type: "blob"},
		{Path: "tests", Type: "tree"},
		{Path: "tests/setup-guide.md", Type: "blob"},
		{Path: "e2e/flow.md", Type: "blob"},
	}

	out := filterNodesByProfile(nodes, SniffProfile{}, nil, patterns)
	seen := map[string]bool{}
	for _, n := range out {
		seen[n.Path] = true
	}
	assert.True(t, seen["docs/getting-started.md"])
	assert.False(t, seen["tests/setup-guide.md"], "测试目录文档必须被过滤")
	assert.False(t, seen["e2e/flow.md"], "e2e 目录文档必须被过滤")
}

// TestCreateDocsForChaptersSkipsUnreadableAsset 非 md 资产归档读取失败时
// 不得产生占位符文档（这里验证纯函数层面的跳过语义源契约：store_pg 的
// 跳过分支存在且计入失败；DB 路径由集成面覆盖）。
func TestCreateDocsForChaptersSkipsUnreadableAsset(t *testing.T) {
	src, err := os.ReadFile("store_pg.go")
	require.NoError(t, err)
	body := string(src)
	start := strings.Index(body, "func (s *PgxStore) CreateDocsForChapters")
	require.NotEqual(t, -1, start, "CreateDocsForChapters 必须存在于 store_pg.go")
	end := strings.Index(body[start:], "\nfunc ")
	segment := body[start : start+end]
	assert.Contains(t, segment, "archive read failed, skipped", "读取失败必须显式跳过并留痕")
	assert.Contains(t, segment, "failed == attempted", "全军覆没必须显式报错（Fail-Closed）")
	assert.NotContains(t, segment, "Content not found.", "严禁占位符顶替正文")
}

