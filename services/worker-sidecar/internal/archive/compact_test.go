package archive

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func createTestRepoDir(t *testing.T, root, owner, repo, sha string) string {
	t.Helper()
	dir := ArchiveDirFor(root, owner, repo, sha)
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "src"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "pkg", "sub"), 0o755))

	require.NoError(t, os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test Repo\nHello world\nLine 3\nLine 4\nLine 5\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "src", "main.go"), []byte("package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"ok\")\n}\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "pkg", "sub", "util.go"), []byte("package sub\n\nfunc Helper() int { return 42 }\n"), 0o644))
	return dir
}

func TestCompactArchivePathFor(t *testing.T) {
	tests := []struct {
		name     string
		root     string
		owner    string
		repo     string
		sha      string
		expected string
	}{
		{
			name:     "standard lowercase",
			root:     "/storage/repos",
			owner:    "octocat",
			repo:     "hello-world",
			sha:      "abc1234",
			expected: filepath.Join("/storage/repos", "octocat", "hello-world", "abc1234.tar.gz"),
		},
		{
			name:     "mixed case owner and repo normalized to lowercase",
			root:     "/storage/repos",
			owner:    "MyOrg",
			repo:     "GreatRepo",
			sha:      "fedcba9876543210fedcba9876543210fedcba98",
			expected: filepath.Join("/storage/repos", "myorg", "greatrepo", "fedcba9876543210fedcba9876543210fedcba98.tar.gz"),
		},
		{
			name:     "default root when empty",
			root:     "",
			owner:    "foo",
			repo:     "bar",
			sha:      "1111111111111111111111111111111111111111",
			expected: filepath.Join("storage/repos", "foo", "bar", "1111111111111111111111111111111111111111.tar.gz"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CompactArchivePathFor(tt.root, tt.owner, tt.repo, tt.sha)
			assert.Equal(t, tt.expected, got)
		})
	}
}

func TestArchiveAutoCompactThresholdBytes(t *testing.T) {
	tests := []struct {
		name     string
		envVal   string
		expected int64
	}{
		{
			name:     "default value when env unset",
			envVal:   "",
			expected: 30 * 1024 * 1024,
		},
		{
			name:     "custom value from env",
			envVal:   "50",
			expected: 50 * 1024 * 1024,
		},
		{
			name:     "invalid value falls back to default",
			envVal:   "invalid",
			expected: 30 * 1024 * 1024,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.envVal == "" {
				_ = os.Unsetenv("ARCHIVE_AUTO_COMPACT_MIN_MB")
			} else {
				_ = os.Setenv("ARCHIVE_AUTO_COMPACT_MIN_MB", tt.envVal)
				defer os.Unsetenv("ARCHIVE_AUTO_COMPACT_MIN_MB")
			}
			got := ArchiveAutoCompactThresholdBytes()
			assert.Equal(t, tt.expected, got)
		})
	}
}

func TestCompactArchive_DefensiveFailures(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()

	tests := []struct {
		name        string
		setup       func() (string, string, string)
		expectError bool
		errMsg      string
	}{
		{
			name: "unsafe owner segment",
			setup: func() (string, string, string) {
				return "../evil", "repo", "1111111111111111111111111111111111111111"
			},
			expectError: true,
			errMsg:      "invalid owner/repo segment",
		},
		{
			name: "unsafe sha segment",
			setup: func() (string, string, string) {
				return "owner", "repo", "invalid_sha_!!!"
			},
			expectError: true,
			errMsg:      "invalid sha segment",
		},
		{
			name: "non-existent expanded directory",
			setup: func() (string, string, string) {
				return "owner", "repo", "2222222222222222222222222222222222222222"
			},
			expectError: true,
			errMsg:      "expanded archive directory does not exist",
		},
		{
			name: "empty directory rejected",
			setup: func() (string, string, string) {
				owner, repo, sha := "owner", "repo", "3333333333333333333333333333333333333333"
				dir := ArchiveDirFor(root, owner, repo, sha)
				require.NoError(t, os.MkdirAll(dir, 0o755))
				return owner, repo, sha
			},
			expectError: true,
			errMsg:      "refusing to compact empty directory",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			owner, repo, sha := tt.setup()
			size, err := CompactArchive(ctx, root, owner, repo, sha)
			if tt.expectError {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.errMsg)
				assert.Zero(t, size)
			} else {
				require.NoError(t, err)
			}
		})
	}
}

func TestCompactAndDecompactArchive_Lifecycle(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	owner := "AcmeCorp"
	repo := "WidgetApp"
	sha := "4444444444444444444444444444444444444444"

	expandedDir := createTestRepoDir(t, root, owner, repo, sha)
	assert.DirExists(t, expandedDir)

	compactedSize, err := CompactArchive(ctx, root, owner, repo, sha)
	require.NoError(t, err)
	assert.Greater(t, compactedSize, int64(0))

	assert.NoDirExists(t, expandedDir)
	compactPath := CompactArchivePathFor(root, owner, repo, sha)
	assert.FileExists(t, compactPath)

	meta, err := NewMetaStore(root).Load()
	require.NoError(t, err)
	key := archiveKey(owner, repo, sha)
	entry, ok := meta[key]
	require.True(t, ok)
	assert.True(t, entry.Compacted)
	assert.Equal(t, compactedSize, entry.Size)

	size2, err := CompactArchive(ctx, root, owner, repo, sha)
	require.NoError(t, err)
	assert.Equal(t, compactedSize, size2)

	t.Run("read full file without slicing", func(t *testing.T) {
		content, err := ReadSingleFileFromCompactArchive(compactPath, "README.md", 0, 0, 2*1024*1024)
		require.NoError(t, err)
		assert.Equal(t, "# Test Repo\nHello world\nLine 3\nLine 4\nLine 5\n", content)
	})

	t.Run("read nested file with subpath", func(t *testing.T) {
		content, err := ReadSingleFileFromCompactArchive(compactPath, "pkg/sub/util.go", 0, 0, 2*1024*1024)
		require.NoError(t, err)
		assert.Equal(t, "package sub\n\nfunc Helper() int { return 42 }\n", content)
	})

	t.Run("read file with line range slice", func(t *testing.T) {
		content, err := ReadSingleFileFromCompactArchive(compactPath, "README.md", 2, 4, 2*1024*1024)
		require.NoError(t, err)
		assert.Equal(t, "Hello world\nLine 3\nLine 4", content)
	})

	t.Run("read file startLine exceeds length", func(t *testing.T) {
		content, err := ReadSingleFileFromCompactArchive(compactPath, "README.md", 999, 1000, 2*1024*1024)
		require.NoError(t, err)
		assert.Empty(t, content)
	})

	t.Run("read non-existent file returns os.ErrNotExist", func(t *testing.T) {
		_, err := ReadSingleFileFromCompactArchive(compactPath, "missing.go", 0, 0, 2*1024*1024)
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("read with unsafe traversal rejected", func(t *testing.T) {
		_, err := ReadSingleFileFromCompactArchive(compactPath, "../outside.txt", 0, 0, 2*1024*1024)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "unsafe or invalid")
	})

	decompDir, err := DecompactArchive(ctx, root, owner, repo, sha)
	require.NoError(t, err)
	assert.Equal(t, expandedDir, decompDir)

	assert.DirExists(t, expandedDir)
	assert.NoFileExists(t, compactPath)

	readmeContent, err := os.ReadFile(filepath.Join(expandedDir, "README.md"))
	require.NoError(t, err)
	assert.Equal(t, "# Test Repo\nHello world\nLine 3\nLine 4\nLine 5\n", string(readmeContent))

	utilContent, err := os.ReadFile(filepath.Join(expandedDir, "pkg", "sub", "util.go"))
	require.NoError(t, err)
	assert.Equal(t, "package sub\n\nfunc Helper() int { return 42 }\n", string(utilContent))

	meta2, err := NewMetaStore(root).Load()
	require.NoError(t, err)
	entry2, ok := meta2[key]
	require.True(t, ok)
	assert.False(t, entry2.Compacted)
	assert.Greater(t, entry2.Size, int64(0))

	decompDir2, err := DecompactArchive(ctx, root, owner, repo, sha)
	require.NoError(t, err)
	assert.Equal(t, expandedDir, decompDir2)
}

func TestEnsureService_CacheHitDecompact(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	owner := "testorg"
	repo := "testrepo"
	sha := "5555555555555555555555555555555555555555"

	createTestRepoDir(t, root, owner, repo, sha)
	_, err := CompactArchive(ctx, root, owner, repo, sha)
	require.NoError(t, err)

	finalDir := ArchiveDirFor(root, owner, repo, sha)
	compactPath := CompactArchivePathFor(root, owner, repo, sha)
	assert.NoDirExists(t, finalDir)
	assert.FileExists(t, compactPath)

	svc := NewEnsureService(Config{ArchiveRoot: root})
	dir, fromCache, err := svc.Ensure(ctx, owner, repo, sha, 0, "")
	require.NoError(t, err)
	assert.True(t, fromCache, "should hit cache via decompacting compactPath")
	assert.Equal(t, finalDir, dir)
	assert.DirExists(t, finalDir)
	assert.NoFileExists(t, compactPath)

	b, err := os.ReadFile(filepath.Join(finalDir, "README.md"))
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(string(b), "# Test Repo"))
}

func TestSweepArchiveCache_DualState(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()

	owner1, repo1, sha1 := "org1", "repo1", "6666666666666666666666666666666666666666"
	dir1 := createTestRepoDir(t, root, owner1, repo1, sha1)

	owner2, repo2, sha2 := "org2", "repo2", "7777777777777777777777777777777777777777"
	createTestRepoDir(t, root, owner2, repo2, sha2)
	compactSize2, err := CompactArchive(ctx, root, owner2, repo2, sha2)
	require.NoError(t, err)
	compactFile2 := CompactArchivePathFor(root, owner2, repo2, sha2)
	assert.FileExists(t, compactFile2)

	expiredTime := time.Now().Add(-40 * 24 * time.Hour).UnixMilli()
	meta := NewMetaStore(root)
	_ = meta.Update(func(m MetaStore) bool {
		m[archiveKey(owner1, repo1, sha1)] = ArchiveMeta{
			Owner: owner1, Repo: repo1, Sha: sha1,
			LastHitAt: expiredTime, CreatedAt: expiredTime,
			Size: 1000,
		}
		m[archiveKey(owner2, repo2, sha2)] = ArchiveMeta{
			Owner: owner2, Repo: repo2, Sha: sha2,
			LastHitAt: expiredTime, CreatedAt: expiredTime,
			Size:      compactSize2,
			Compacted: true,
		}
		return true
	})
	_ = meta.Flush()

	report, err := SweepArchiveCache(ctx, root, map[string]bool{})
	require.NoError(t, err)
	assert.Equal(t, 2, report.Removed, "both expanded dir and compact tar.gz should be removed by sweep")

	assert.NoDirExists(t, dir1)
	assert.NoFileExists(t, compactFile2)

	metaAfter, err := meta.Load()
	require.NoError(t, err)
	assert.NotContains(t, metaAfter, archiveKey(owner1, repo1, sha1))
	assert.NotContains(t, metaAfter, archiveKey(owner2, repo2, sha2))
}

func TestReadSingleFile_ExactMatchAndWindowsSeparators(t *testing.T) {
	root := t.TempDir()
	owner, repo, sha := "testorg", "exactrepo", "8888888888888888888888888888888888888888"
	dir := ArchiveDirFor(root, owner, repo, sha)
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "cmd"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "pkg", "sub"), 0o755))

	require.NoError(t, os.WriteFile(filepath.Join(dir, "main.go"), []byte("package root\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "cmd", "main.go"), []byte("package cmd\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "pkg", "sub", "util.go"), []byte("package sub\n"), 0o644))

	_, err := CompactArchive(context.Background(), root, owner, repo, sha)
	require.NoError(t, err)
	compactPath := CompactArchivePathFor(root, owner, repo, sha)

	rootMain, err := ReadSingleFileFromCompactArchive(compactPath, "main.go", 0, 0, 1024*1024)
	require.NoError(t, err)
	assert.Equal(t, "package root\n", rootMain)

	cmdMain, err := ReadSingleFileFromCompactArchive(compactPath, "cmd/main.go", 0, 0, 1024*1024)
	require.NoError(t, err)
	assert.Equal(t, "package cmd\n", cmdMain)

	_, err = ReadSingleFileFromCompactArchive(compactPath, "util.go", 0, 0, 1024*1024)
	assert.ErrorIs(t, err, os.ErrNotExist)

	subUtil, err := ReadSingleFileFromCompactArchive(compactPath, "pkg\\sub\\util.go", 0, 0, 1024*1024)
	require.NoError(t, err)
	assert.Equal(t, "package sub\n", subUtil)

	inverted, err := ReadSingleFileFromCompactArchive(compactPath, "main.go", 5, 2, 1024*1024)
	require.NoError(t, err)
	assert.Empty(t, inverted)
}

func TestReadSingleFile_SizeLimit(t *testing.T) {
	root := t.TempDir()
	owner, repo, sha := "testorg", "sizerepo", "9999999999999999999999999999999999999999"
	dir := ArchiveDirFor(root, owner, repo, sha)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "large.txt"), make([]byte, 50*1024), 0o644))

	_, err := CompactArchive(context.Background(), root, owner, repo, sha)
	require.NoError(t, err)
	compactPath := CompactArchivePathFor(root, owner, repo, sha)

	_, err = ReadSingleFileFromCompactArchive(compactPath, "large.txt", 0, 0, 10*1024)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrFileTooLarge)
}

func TestDecompactArchive_SymlinkSecurity(t *testing.T) {
	root := t.TempDir()
	owner, repo, sha := "testorg", "symrepo", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	dir := ArchiveDirFor(root, owner, repo, sha)
	require.NoError(t, os.MkdirAll(dir, 0o755))

	require.NoError(t, os.WriteFile(filepath.Join(dir, "real.txt"), []byte("content"), 0o644))
	require.NoError(t, os.Symlink("real.txt", filepath.Join(dir, "link.txt")))

	_, err := CompactArchive(context.Background(), root, owner, repo, sha)
	require.NoError(t, err)

	decompDir, err := DecompactArchive(context.Background(), root, owner, repo, sha)
	require.NoError(t, err)
	assert.FileExists(t, filepath.Join(decompDir, "link.txt"))
}

func TestEnsureService_CancelledContextPreservesCompact(t *testing.T) {
	root := t.TempDir()
	owner, repo, sha := "testorg", "cancelrepo", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	createTestRepoDir(t, root, owner, repo, sha)
	_, err := CompactArchive(context.Background(), root, owner, repo, sha)
	require.NoError(t, err)

	compactPath := CompactArchivePathFor(root, owner, repo, sha)
	assert.FileExists(t, compactPath)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	svc := NewEnsureService(Config{ArchiveRoot: root})
	_, _, err = svc.Ensure(ctx, owner, repo, sha, 0, "")
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)

	assert.FileExists(t, compactPath, "compactPath must be preserved when Ensure is cancelled")
}

func TestSweepArchiveCache_ReconcileGhostDualState(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	owner, repo, sha := "testorg", "ghostrepo", "cccccccccccccccccccccccccccccccccccccccc"

	dir := createTestRepoDir(t, root, owner, repo, sha)

	compactSize, err := CompactArchive(ctx, root, owner, repo, sha)
	require.NoError(t, err)
	compactFile := CompactArchivePathFor(root, owner, repo, sha)

	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "ghost.txt"), []byte("leftover"), 0o644))

	assert.DirExists(t, dir)
	assert.FileExists(t, compactFile)

	meta := NewMetaStore(root)
	_ = meta.Update(func(m MetaStore) bool {
		m[archiveKey(owner, repo, sha)] = ArchiveMeta{
			Owner: owner, Repo: repo, Sha: sha,
			LastHitAt: time.Now().UnixMilli(), CreatedAt: time.Now().UnixMilli(),
			Size:      compactSize,
			Compacted: true,
		}
		return true
	})
	_ = meta.Flush()

	report, err := SweepArchiveCache(ctx, root, map[string]bool{archiveKey(owner, repo, sha): true})
	require.NoError(t, err)
	assert.Equal(t, 0, report.Removed)

	assert.NoDirExists(t, dir, "ghost directory should be removed by sweep reconciliation")
	assert.FileExists(t, compactFile, "canonical compact archive should be preserved")
}
