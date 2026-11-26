package archive

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCheckFreeDiskSpace(t *testing.T) {
	tempDir := t.TempDir()
	free, err := CheckFreeDiskSpace(tempDir)
	require.NoError(t, err)
	assert.Greater(t, free, uint64(0), "free disk space should be greater than zero")
}

func TestEnsureDiskSpaceForArchive_AbundantSpace(t *testing.T) {
	tempDir := t.TempDir()
	free, err := EnsureDiskSpaceForArchive(context.Background(), tempDir, 1, nil)
	require.NoError(t, err)
	assert.Greater(t, free, uint64(1<<20))
}

func TestEnsureDiskSpaceForArchive_ProactiveSweepTriggered(t *testing.T) {
	tempDir := t.TempDir()

	oldArchive := filepath.Join(tempDir, "coldowner", "coldrepo", "coldsha")
	require.NoError(t, os.MkdirAll(oldArchive, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(oldArchive, "code.go"), []byte("package main"), 0o644))

	oldTime := time.Now().Add(-35 * 24 * time.Hour).UnixMilli()
	meta := NewMetaStore(tempDir)
	_ = meta.Update(func(m MetaStore) bool {
		m["coldowner/coldrepo@coldsha"] = ArchiveMeta{
			Owner: "coldowner", Repo: "coldrepo", Sha: "coldsha",
			Size: 1024, Hits: 0, LastHitAt: oldTime, CreatedAt: oldTime,
		}
		return true
	})

	_, err := EnsureDiskSpaceForArchive(context.Background(), tempDir, 999999999, nil)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "insufficient disk space")

	assert.NoDirExists(t, oldArchive, "cold archive should have been purged by proactive sweep")
}
