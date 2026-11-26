package mcp

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCleanSourcePathRaw(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		want   string
		wantOK bool
	}{
		{name: "相对路径通过", input: "src/lib/a.ts", want: "src/lib/a.ts", wantOK: true},
		{name: "./ 前缀剥除", input: "./src/a.ts", want: "src/a.ts", wantOK: true},
		{name: "空白裁剪", input: "  spaced.ts  ", want: "spaced.ts", wantOK: true},
		{name: "路径穿越拒绝", input: "../etc/passwd", want: "", wantOK: false},
		{name: "中间穿越拒绝", input: "a/../../b.ts", want: "", wantOK: false},
		{name: "绝对路径拒绝", input: "/etc/passwd", want: "", wantOK: false},
		{name: "反斜杠前缀拒绝", input: "\\windows\\system32", want: "", wantOK: false},
		{name: "空串拒绝", input: "", want: "", wantOK: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := cleanSourcePathRaw(tt.input)
			assert.Equal(t, tt.wantOK, ok)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestReadRawSourceFile(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "acme", "calc", "sha1", "src"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "acme", "calc", "sha1", "src", "a.go"), []byte("package x\n"), 0o644))

	t.Run("归档命中返回全文", func(t *testing.T) {
		got := readRawSourceFile(root, "acme", "calc", "sha1", "src/a.go")
		assert.Equal(t, "package x\n", got)
	})

	t.Run("未命中返回空串", func(t *testing.T) {
		assert.Empty(t, readRawSourceFile(root, "acme", "calc", "sha1", "missing.go"))
		assert.Empty(t, readRawSourceFile(root, "acme", "calc", "other-ref", "src/a.go"))
	})

	t.Run("路径穿越拒绝", func(t *testing.T) {
		assert.Empty(t, readRawSourceFile(root, "acme", "calc", "sha1", "../../secret.txt"))
	})

	t.Run("空参短路", func(t *testing.T) {
		assert.Empty(t, readRawSourceFile("", "acme", "calc", "sha1", "a.go"))
		assert.Empty(t, readRawSourceFile(root, "", "calc", "sha1", "a.go"))
	})

	t.Run("文件超上限拒绝", func(t *testing.T) {
		largePath := filepath.Join(root, "acme", "calc", "sha1", "src", "huge.bin")
		require.NoError(t, os.WriteFile(largePath, make([]byte, maxSourceFileReadBytes+10*1024), 0o644))
		assert.Empty(t, readRawSourceFile(root, "acme", "calc", "sha1", "src/huge.bin"))
	})

	t.Run("收卷态 .tar.gz 免解压直读", func(t *testing.T) {
		sha := "c001c001c001c001c001c001c001c001c001c001"
		compactDir := filepath.Join(root, "acme", "calc", sha, "src")
		require.NoError(t, os.MkdirAll(compactDir, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(compactDir, "compact.go"), []byte("package compact\n\nconst Version = \"1.0.0\"\n"), 0o644))
		_, err := archive.CompactArchive(context.Background(), root, "acme", "calc", sha)
		require.NoError(t, err)

		got := readRawSourceFile(root, "acme", "calc", sha, "src/compact.go")
		assert.Equal(t, "package compact\n\nconst Version = \"1.0.0\"\n", got)
	})

	t.Run("收卷态超大文件拒绝读取并返回空", func(t *testing.T) {
		sha := "c002c002c002c002c002c002c002c002c002c002"
		compactDir := filepath.Join(root, "acme", "calc", sha, "src")
		require.NoError(t, os.MkdirAll(compactDir, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(compactDir, "huge.bin"), make([]byte, maxSourceFileReadBytes+10*1024), 0o644))
		_, err := archive.CompactArchive(context.Background(), root, "acme", "calc", sha)
		require.NoError(t, err)

		got := readRawSourceFile(root, "acme", "calc", sha, "src/huge.bin")
		assert.Empty(t, got, "oversized file in compact archive must return empty")
	})
}

func TestNonEmptyStrings(t *testing.T) {
	assert.Equal(t, []string{"sha", "main"}, nonEmptyStrings("sha", "", "main"))
	assert.Empty(t, nonEmptyStrings("", ""))
}

func TestRunHubReadSourceFile(t *testing.T) {
	fakeStore := newReadFakeStore()
	reader := &readService{store: fakeStore}

	t.Run("缺少 repository 时提示指引", func(t *testing.T) {
		p := "main.go"
		res := reader.runHubReadSourceFile(context.Background(), "user-1", "cursor", "", readSourceFileArgs{
			Path: &p,
		})
		assert.True(t, res.IsError)
		assert.Contains(t, res.Text, `pass "repository"`)
	})

	t.Run("未在书架或不存在的 repository 返回错误", func(t *testing.T) {
		p := "main.go"
		res := reader.runHubReadSourceFile(context.Background(), "user-1", "cursor", "not-in-bookshelf/repo", readSourceFileArgs{
			Path: &p,
		})
		assert.True(t, res.IsError)
		assert.Contains(t, res.Text, "not found in your OpenGits Hub")
	})

	t.Run("私有仓无权限返回 Forbidden", func(t *testing.T) {
		fakeStore.bookshelfResolved["user-1|private/repo"] = &ResolvedRepo{
			Repository: RepoRow{ID: "priv-1", Owner: "private", Repo: "repo", IsPublic: false},
		}
		p := "main.go"
		res := reader.runHubReadSourceFile(context.Background(), "user-1", "cursor", "private/repo", readSourceFileArgs{
			Path: &p,
		})
		assert.True(t, res.IsError)
		assert.Contains(t, res.Text, "Forbidden: Repository")
	})

	t.Run("私有仓拥有 SavedRepoAccess 允许访问", func(t *testing.T) {
		fakeStore.bookshelfResolved["user-1|private/allowed"] = &ResolvedRepo{
			Repository: RepoRow{ID: "priv-2", Owner: "private", Repo: "allowed", IsPublic: false},
		}
		fakeStore.savedRepos["priv-2|user-1"] = true
		p := "main.go"
		res := reader.runHubReadSourceFile(context.Background(), "user-1", "cursor", "private/allowed", readSourceFileArgs{
			Path: &p,
		})

		assert.True(t, res.IsError)
		assert.NotContains(t, res.Text, "Forbidden")
		assert.Contains(t, res.Text, "File not found")
	})
}
