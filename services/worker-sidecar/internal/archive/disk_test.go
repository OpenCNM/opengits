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
	// 要求 1MB，必定满足
	free, err := EnsureDiskSpaceForArchive(context.Background(), tempDir, 1, nil)
	require.NoError(t, err)
	assert.Greater(t, free, uint64(1<<20))
}

func TestEnsureDiskSpaceForArchive_ProactiveSweepTriggered(t *testing.T) {
	tempDir := t.TempDir()

	// 构造一个冷归档条目以供 sweep 清理
	oldArchive := filepath.Join(tempDir, "coldowner", "coldrepo", "coldsha")
	require.NoError(t, os.MkdirAll(oldArchive, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(oldArchive, "code.go"), []byte("package main"), 0o644))

	// 设置元数据：35 天前无命中（应被 TTL 命中并清除）
	oldTime := time.Now().Add(-35 * 24 * time.Hour).UnixMilli()
	meta := NewMetaStore(tempDir)
	_ = meta.Update(func(m MetaStore) bool {
		m["coldowner/coldrepo@coldsha"] = ArchiveMeta{
			Owner: "coldowner", Repo: "coldrepo", Sha: "coldsha",
			Size: 1024, Hits: 0, LastHitAt: oldTime, CreatedAt: oldTime,
		}
		return true
	})

	// 传入一个极端巨大的磁盘要求（例如 999999999 MB），强制触发 proactive sweep，随后返回不足错误
	_, err := EnsureDiskSpaceForArchive(context.Background(), tempDir, 999999999, nil)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "insufficient disk space")

	// 验证冷归档确实在熔断前被 proactive sweep 清除了
	assert.NoDirExists(t, oldArchive, "cold archive should have been purged by proactive sweep")
}
