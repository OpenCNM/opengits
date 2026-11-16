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

// ─────────────────────────────────────────────────────────────
// WP-G：归档缓存清扫（TTL/水位/活跃保护/评分序）
// ─────────────────────────────────────────────────────────────

func writeSweepArchive(t *testing.T, root, owner, repo, sha string, sizeBytes int, lastHit time.Time) string {
	t.Helper()
	dir := filepath.Join(root, owner, repo, sha)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "payload.bin"), make([]byte, sizeBytes), 0o644))
	require.NoError(t, os.Chtimes(dir, lastHit, lastHit))
	return dir
}

func TestSweepArchiveCacheTTLAndActiveProtection(t *testing.T) {
	root := t.TempDir()
	old := time.Now().Add(-45 * 24 * time.Hour)
	writeSweepArchive(t, root, "o", "r", "stale", 1024, old)
	writeSweepArchive(t, root, "o", "r", "active-old", 1024, old)
	writeSweepArchive(t, root, "o", "r", "fresh", 1024, time.Now())

	report, err := SweepArchiveCache(context.Background(), root, map[string]bool{"o/r@active-old": true})
	require.NoError(t, err)
	assert.Equal(t, 1, report.Removed, "only the stale non-active entry is TTL-removed")

	for _, sha := range []string{"active-old", "fresh"} {
		_, err := os.Stat(filepath.Join(root, "o", "r", sha))
		assert.NoError(t, err, "active/fresh archive must survive: %s", sha)
	}
	_, err = os.Stat(filepath.Join(root, "o", "r", "stale"))
	assert.True(t, os.IsNotExist(err), "stale archive must be removed")
}

func TestSweepArchiveCacheWatermarkEviction(t *testing.T) {
	t.Run("cold large entry evicted first, eviction stops at low watermark", func(t *testing.T) {
		root := t.TempDir()
		now := time.Now()
		writeSweepArchive(t, root, "o", "r", "cold-big", 4<<20, now.Add(-40*24*time.Hour))
		writeSweepArchive(t, root, "o", "r", "fresh-small", 1<<20, now)
		require.NoError(t, NewMetaStore(root).Update(func(m MetaStore) bool {
			m["o/r@fresh-small"] = ArchiveMeta{Owner: "o", Repo: "r", Sha: "fresh-small", Hits: 20, LastHitAt: now.UnixMilli(), CreatedAt: now.UnixMilli()}
			return true
		}))
		t.Setenv("TARBALL_CACHE_HIGH_MB", "2")
		t.Setenv("TARBALL_CACHE_LOW_MB", "1")

		report, err := SweepArchiveCache(context.Background(), root, nil)
		require.NoError(t, err)
		assert.Equal(t, 1, report.Removed, "cold-big alone brings total below low watermark")
		_, err = os.Stat(filepath.Join(root, "o", "r", "cold-big"))
		assert.True(t, os.IsNotExist(err))
		_, err = os.Stat(filepath.Join(root, "o", "r", "fresh-small"))
		assert.NoError(t, err, "hot small entry must survive")
	})

	t.Run("active entry evicted last among equals", func(t *testing.T) {
		root := t.TempDir()
		old := time.Now().Add(-40 * 24 * time.Hour)
		writeSweepArchive(t, root, "o", "r", "inactive-old", 1<<20, old)
		writeSweepArchive(t, root, "o", "r", "active-old", 1<<20, old)
		t.Setenv("TARBALL_CACHE_HIGH_MB", "1")
		t.Setenv("TARBALL_CACHE_LOW_MB", "1")

		report, err := SweepArchiveCache(context.Background(), root, map[string]bool{"o/r@active-old": true})
		require.NoError(t, err)
		assert.Equal(t, 1, report.Removed)
		_, err = os.Stat(filepath.Join(root, "o", "r", "active-old"))
		assert.NoError(t, err, "active entry (x10 score) must outlive the identical inactive one")
	})
}

func TestEvictionScoreOrdering(t *testing.T) {
	coldBig := evictionScore(0, 40*24*time.Hour, 4<<20)
	hotSmall := evictionScore(50, time.Hour, 1<<20)
	assert.Less(t, coldBig, hotSmall, "cold + low-frequency + large must be evicted first")
}

func TestSweepMissingRootIsNoop(t *testing.T) {
	report, err := SweepArchiveCache(context.Background(), filepath.Join(t.TempDir(), "does-not-exist"), nil)
	require.NoError(t, err)
	assert.Equal(t, 0, report.Removed)
}
