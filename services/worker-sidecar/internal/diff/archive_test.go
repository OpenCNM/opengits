package diff

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 🧪 [1.14.3.3] TestHandleArchiveDiff 行级 Myers 差异比对与归档对比
func TestHandleArchiveDiff(t *testing.T) {
	tempRoot := t.TempDir()
	h := NewHandler(tempRoot)

	oldDir := filepath.Join(tempRoot, "acme", "repo", "sha-old")
	newDir := filepath.Join(tempRoot, "acme", "repo", "sha-new")
	require.NoError(t, os.MkdirAll(oldDir, 0755))
	require.NoError(t, os.MkdirAll(newDir, 0755))

	// old: unchanged.txt, modified.txt, rename_me.txt
	require.NoError(t, os.WriteFile(filepath.Join(oldDir, "unchanged.txt"), []byte("same content"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(oldDir, "modified.txt"), []byte("version 1"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(oldDir, "rename_me.txt"), []byte("rename payload"), 0644))

	// new: unchanged.txt, modified.txt (changed), renamed_to.txt (same hash as rename_me), added.txt
	require.NoError(t, os.WriteFile(filepath.Join(newDir, "unchanged.txt"), []byte("same content"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(newDir, "modified.txt"), []byte("version 2"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(newDir, "renamed_to.txt"), []byte("rename payload"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(newDir, "added.txt"), []byte("new file"), 0644))

	tests := []struct {
		name       string
		payload    any
		wantStatus int
		checkFn    func(t *testing.T, resp *httptest.ResponseRecorder)
	}{
		{
			name:       "bad request when fields are missing",
			payload:    ArchiveDiffRequest{Owner: "", Repo: "repo", OldSha: "sha-old", NewSha: "sha-new"},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "bad request when owner contains traversal",
			payload:    ArchiveDiffRequest{Owner: "../evil", Repo: "repo", OldSha: "sha-old", NewSha: "sha-new"},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "not found when archive directory does not exist",
			payload:    ArchiveDiffRequest{Owner: "acme", Repo: "repo", OldSha: "sha-old", NewSha: "sha-missing"},
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "1.14.3.3 success archive diff calculation with renames and additions",
			payload:    ArchiveDiffRequest{Owner: "acme", Repo: "repo", OldSha: "sha-old", NewSha: "sha-new"},
			wantStatus: http.StatusOK,
			checkFn: func(t *testing.T, resp *httptest.ResponseRecorder) {
				var diff ArchiveDiff
				require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &diff))
				assert.Contains(t, diff.Added, "added.txt")
				assert.Contains(t, diff.Modified, "modified.txt")
				assert.NotContains(t, diff.Added, "renamed_to.txt")
				assert.NotContains(t, diff.Removed, "rename_me.txt")
				require.Len(t, diff.Renamed, 1)
				assert.Equal(t, "rename_me.txt", diff.Renamed[0].From)
				assert.Equal(t, "renamed_to.txt", diff.Renamed[0].To)
			},
		},
		{
			name:       "success archive diff calculation using FromSha and ToSha aliases",
			payload:    ArchiveDiffRequest{Owner: "acme", Repo: "repo", FromSha: "sha-old", ToSha: "sha-new"},
			wantStatus: http.StatusOK,
			checkFn: func(t *testing.T, resp *httptest.ResponseRecorder) {
				var diff ArchiveDiff
				require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &diff))
				assert.Contains(t, diff.Added, "added.txt")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b, err := json.Marshal(tt.payload)
			require.NoError(t, err)
			req := httptest.NewRequest(http.MethodPost, "/v1/archive/diff", bytes.NewReader(b))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			h.HandleArchiveDiff(w, req)

			assert.Equal(t, tt.wantStatus, w.Code)
			if tt.checkFn != nil {
				tt.checkFn(t, w)
			}
		})
	}
}

// 🧪 [BUG-05] TestDiffArchiveTreesWithContent_SimilarityRename 验证基于行相似度的跨文件重命名识别与确定性判定
func TestDiffArchiveTreesWithContent_SimilarityRename(t *testing.T) {
	oldContent := []byte("Line 1: Introduction\nLine 2: Installation\nLine 3: Quick Start\nLine 4: Configuration\nLine 5: Architecture\nLine 6: API Reference\nLine 7: Best Practices\nLine 8: Troubleshooting\nLine 9: FAQ\nLine 10: Conclusion\n")
	// 9 out of 10 lines identical (90% similarity > 0.60 threshold)
	newContent := []byte("Line 1: Introduction\nLine 2: Installation Updated\nLine 3: Quick Start\nLine 4: Configuration\nLine 5: Architecture\nLine 6: API Reference\nLine 7: Best Practices\nLine 8: Troubleshooting\nLine 9: FAQ\nLine 10: Conclusion\n")

	oldTree := map[string]string{
		"docs/getting-started.md": "hash-old-getting-started",
	}
	newTree := map[string]string{
		"docs/quickstart.md": "hash-new-quickstart",
	}

	readOld := func(p string) ([]byte, error) {
		if p == "docs/getting-started.md" {
			return oldContent, nil
		}
		return nil, os.ErrNotExist
	}
	readNew := func(p string) ([]byte, error) {
		if p == "docs/quickstart.md" {
			return newContent, nil
		}
		return nil, os.ErrNotExist
	}

	d := DiffArchiveTreesWithContent(oldTree, newTree, readOld, readNew, 0.60)
	require.NotNil(t, d)
	assert.Empty(t, d.Added)
	assert.Empty(t, d.Removed)
	require.Len(t, d.Renamed, 1)
	assert.Equal(t, "docs/getting-started.md", d.Renamed[0].From)
	assert.Equal(t, "docs/quickstart.md", d.Renamed[0].To)
}

// 🧪 [BUG-05] TestDiffArchiveTreesWithContent_BelowThreshold 相似度低于阈值时保持为删除与新增
func TestDiffArchiveTreesWithContent_BelowThreshold(t *testing.T) {
	oldContent := []byte("alpha\nbeta\ngamma\n")
	newContent := []byte("one\ntwo\nthree\nfour\nfive\n")

	oldTree := map[string]string{"docs/old.md": "hash-old"}
	newTree := map[string]string{"docs/new.md": "hash-new"}

	readOld := func(p string) ([]byte, error) { return oldContent, nil }
	readNew := func(p string) ([]byte, error) { return newContent, nil }

	d := DiffArchiveTreesWithContent(oldTree, newTree, readOld, readNew, 0.60)
	require.NotNil(t, d)
	assert.Equal(t, []string{"docs/new.md"}, d.Added)
	assert.Equal(t, []string{"docs/old.md"}, d.Removed)
	assert.Empty(t, d.Renamed)
}

// 🧪 [BUG-05] TestDiffArchiveTreesWithContent_CrossExtension MD 与 MDX 格式互认
func TestDiffArchiveTreesWithContent_CrossExtension(t *testing.T) {
	content := []byte("# Header\nContent line 1\nContent line 2\nContent line 3\n")

	oldTree := map[string]string{"docs/page.md": "hash-md"}
	newTree := map[string]string{"docs/page.mdx": "hash-mdx"}

	readOld := func(p string) ([]byte, error) { return content, nil }
	readNew := func(p string) ([]byte, error) { return content, nil }

	d := DiffArchiveTreesWithContent(oldTree, newTree, readOld, readNew, 0.60)
	require.NotNil(t, d)
	assert.Empty(t, d.Added)
	assert.Empty(t, d.Removed)
	require.Len(t, d.Renamed, 1)
	assert.Equal(t, "docs/page.md", d.Renamed[0].From)
	assert.Equal(t, "docs/page.mdx", d.Renamed[0].To)
}

// 🧪 [BUG-05] TestDiffArchiveTreesWithContent_DeterministicMultipleCandidates 确定性多候选排序稳定性
func TestDiffArchiveTreesWithContent_DeterministicMultipleCandidates(t *testing.T) {
	for iter := 0; iter < 20; iter++ {
		oldTree := map[string]string{
			"a.txt": "ha",
			"b.txt": "hb",
		}
		newTree := map[string]string{
			"c.txt": "hc",
			"d.txt": "hd",
		}
		read := func(p string) ([]byte, error) {
			return []byte("common line 1\ncommon line 2\ncommon line 3\n"), nil
		}
		d := DiffArchiveTreesWithContent(oldTree, newTree, read, read, 0.60)
		require.Len(t, d.Renamed, 2)
		assert.Equal(t, "a.txt", d.Renamed[0].From)
		assert.Equal(t, "c.txt", d.Renamed[0].To)
		assert.Equal(t, "b.txt", d.Renamed[1].From)
		assert.Equal(t, "d.txt", d.Renamed[1].To)
	}
}

// 🧪 [BUG-05] TestComputeArchiveDiffFromDisk_SimilarityRename 磁盘真实归档行相似度重命名端到端验证
func TestComputeArchiveDiffFromDisk_SimilarityRename(t *testing.T) {
	tempRoot := t.TempDir()
	oldDir := filepath.Join(tempRoot, "org", "repo", "sha-1")
	newDir := filepath.Join(tempRoot, "org", "repo", "sha-2")
	require.NoError(t, os.MkdirAll(filepath.Join(oldDir, "docs"), 0755))
	require.NoError(t, os.MkdirAll(filepath.Join(newDir, "docs"), 0755))

	oldDoc := "Title: Overview\nSection 1: Architecture\nSection 2: Components\nSection 3: Flow\nSection 4: Summary\n"
	// Section 2 slightly modified
	newDoc := "Title: Overview\nSection 1: Architecture\nSection 2: Components and Modules\nSection 3: Flow\nSection 4: Summary\n"

	require.NoError(t, os.WriteFile(filepath.Join(oldDir, "docs", "arch_old.md"), []byte(oldDoc), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(newDir, "docs", "arch_new.md"), []byte(newDoc), 0644))

	diffResult, hasOld, err := ComputeArchiveDiffFromDisk(tempRoot, "org", "repo", "sha-1", "sha-2")
	require.NoError(t, err)
	assert.True(t, hasOld)
	assert.Empty(t, diffResult.Added)
	assert.Empty(t, diffResult.Removed)
	require.Len(t, diffResult.Renamed, 1)
	assert.Equal(t, "docs/arch_old.md", diffResult.Renamed[0].From)
	assert.Equal(t, "docs/arch_new.md", diffResult.Renamed[0].To)
}

func TestComputeArchiveDiffFromDisk_CompactArchiveDecompact(t *testing.T) {
	tempRoot := t.TempDir()
	owner, repo := "myorg", "myrepo"
	sha1 := "1111111111111111111111111111111111111111"
	sha2 := "2222222222222222222222222222222222222222"

	dir1 := archive.ArchiveDirFor(tempRoot, owner, repo, sha1)
	dir2 := archive.ArchiveDirFor(tempRoot, owner, repo, sha2)
	require.NoError(t, os.MkdirAll(dir1, 0o755))
	require.NoError(t, os.MkdirAll(dir2, 0o755))

	require.NoError(t, os.WriteFile(filepath.Join(dir1, "file.txt"), []byte("v1"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir2, "file.txt"), []byte("v2"), 0o644))

	// 将 sha1 收卷打包为 .tar.gz
	_, err := archive.CompactArchive(context.Background(), tempRoot, owner, repo, sha1)
	require.NoError(t, err)

	// dir1 不存在，compact 存在
	assert.NoDirExists(t, dir1)
	assert.FileExists(t, archive.CompactArchivePathFor(tempRoot, owner, repo, sha1))

	// 调用 ComputeArchiveDiffFromDisk，期望自动展开收卷态并成功比对
	diffResult, hasOld, err := ComputeArchiveDiffFromDisk(tempRoot, owner, repo, sha1, sha2)
	require.NoError(t, err)
	assert.True(t, hasOld)
	assert.Equal(t, []string{"file.txt"}, diffResult.Modified)
	assert.Empty(t, diffResult.Added)
	assert.Empty(t, diffResult.Removed)
	assert.DirExists(t, dir1, "dir1 should have been restored via DecompactArchive")
}

func TestHandleArchiveDiff_CompactArchiveSuccess(t *testing.T) {
	tempRoot := t.TempDir()
	owner, repo := "apiorg", "apirepo"
	sha1 := "5555555555555555555555555555555555555555"
	sha2 := "6666666666666666666666666666666666666666"

	dir1 := archive.ArchiveDirFor(tempRoot, owner, repo, sha1)
	dir2 := archive.ArchiveDirFor(tempRoot, owner, repo, sha2)
	require.NoError(t, os.MkdirAll(dir1, 0o755))
	require.NoError(t, os.MkdirAll(dir2, 0o755))

	require.NoError(t, os.WriteFile(filepath.Join(dir1, "code.go"), []byte("v1"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir2, "code.go"), []byte("v2"), 0o644))

	_, err := archive.CompactArchive(context.Background(), tempRoot, owner, repo, sha1)
	require.NoError(t, err)
	_, err = archive.CompactArchive(context.Background(), tempRoot, owner, repo, sha2)
	require.NoError(t, err)

	handler := NewHandler(tempRoot)
	payload := map[string]string{
		"owner":   owner,
		"repo":    repo,
		"oldSha":  sha1,
		"newSha":  sha2,
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v1/archive/diff", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleArchiveDiff(w, req)
	assert.Equal(t, http.StatusOK, w.Code, "compact archives should be recognized and handled cleanly")
}
