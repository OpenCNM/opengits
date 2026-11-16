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
// 派生产物清扫（TTL/活跃保护/tmp 残骸/空目录回收/大小写口径）
// ─────────────────────────────────────────────────────────────

func writeArtifact(t *testing.T, root, owner, repo, fileName string, sizeBytes int, mtime time.Time) string {
	t.Helper()
	dir := filepath.Join(root, owner, repo)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	path := filepath.Join(dir, fileName)
	require.NoError(t, os.WriteFile(path, make([]byte, sizeBytes), 0o644))
	require.NoError(t, os.Chtimes(path, mtime, mtime))
	return path
}

func TestSweepArtifactFiles(t *testing.T) {
	ttl := 30 * 24 * time.Hour

	t.Run("stale non-active artifact removed, active and fresh survive", func(t *testing.T) {
		root := t.TempDir()
		old := time.Now().Add(-45 * 24 * time.Hour)
		writeArtifact(t, root, "o", "r", "stale.json", 512, old)
		writeArtifact(t, root, "o", "r", "canonical.json", 512, old)
		writeArtifact(t, root, "o", "r", "fresh.json", 512, time.Now())

		report, err := SweepArtifactFiles(context.Background(), root, map[string]bool{"o/r@canonical": true}, ttl)
		require.NoError(t, err)
		assert.Equal(t, 1, report.Removed)
		assert.Equal(t, int64(512), report.FreedBytes)

		for _, name := range []string{"canonical.json", "fresh.json"} {
			_, err := os.Stat(filepath.Join(root, "o", "r", name))
			assert.NoError(t, err, "%s must survive", name)
		}
		_, err = os.Stat(filepath.Join(root, "o", "r", "stale.json"))
		assert.True(t, os.IsNotExist(err), "stale artifact must be removed")
	})

	t.Run("active key comparison is case-insensitive (DB keys lowercase)", func(t *testing.T) {
		root := t.TempDir()
		old := time.Now().Add(-45 * 24 * time.Hour)
		writeArtifact(t, root, "Vercel", "Next.js", "abc123.json", 64, old)

		report, err := SweepArtifactFiles(context.Background(), root, map[string]bool{"vercel/next.js@abc123": true}, ttl)
		require.NoError(t, err)
		assert.Equal(t, 0, report.Removed, "disk keeps import-time casing, DB key is lowercase")
	})

	t.Run("tmp atomic-write debris swept by staleness regardless of active keys", func(t *testing.T) {
		root := t.TempDir()
		old := time.Now().Add(-45 * 24 * time.Hour)
		debris := writeArtifact(t, root, "o", "r", "head.json.tmp-12345", 32, old)
		freshDebris := writeArtifact(t, root, "o", "r", "head.json.tmp-99999", 32, time.Now())

		report, err := SweepArtifactFiles(context.Background(), root, map[string]bool{"o/r@head": true}, ttl)
		require.NoError(t, err)
		assert.Equal(t, 1, report.Removed, "only stale debris is removed; head artifact itself is active-protected")
		_, err = os.Stat(debris)
		assert.True(t, os.IsNotExist(err))
		_, err = os.Stat(freshDebris)
		assert.NoError(t, err, "recent debris (write possibly in flight) must survive")
	})

	t.Run("non-json files are left alone", func(t *testing.T) {
		root := t.TempDir()
		old := time.Now().Add(-45 * 24 * time.Hour)
		kept := writeArtifact(t, root, "o", "r", "notes.txt", 16, old)

		report, err := SweepArtifactFiles(context.Background(), root, nil, ttl)
		require.NoError(t, err)
		assert.Equal(t, 0, report.Removed)
		_, err = os.Stat(kept)
		assert.NoError(t, err)
	})

	t.Run("empty repo dir reclaimed after last artifact removal", func(t *testing.T) {
		root := t.TempDir()
		old := time.Now().Add(-45 * 24 * time.Hour)
		writeArtifact(t, root, "o", "gone", "stale.json", 64, old)
		writeArtifact(t, root, "o", "kept", "fresh.json", 64, time.Now())

		_, err := SweepArtifactFiles(context.Background(), root, nil, ttl)
		require.NoError(t, err)
		_, err = os.Stat(filepath.Join(root, "o", "gone"))
		assert.True(t, os.IsNotExist(err), "emptied repo dir must be reclaimed")
		_, err = os.Stat(filepath.Join(root, "o", "kept", "fresh.json"))
		assert.NoError(t, err)
	})

	t.Run("missing root and empty dir are no-ops", func(t *testing.T) {
		report, err := SweepArtifactFiles(context.Background(), filepath.Join(t.TempDir(), "nope"), nil, ttl)
		require.NoError(t, err)
		assert.Equal(t, SweepReport{}, report)

		report, err = SweepArtifactFiles(context.Background(), "", nil, ttl)
		require.NoError(t, err)
		assert.Equal(t, SweepReport{}, report)
	})
}

func TestSweepArtifactFilesTTLBoundary(t *testing.T) {
	ttl := 14 * 24 * time.Hour
	tests := []struct {
		name string
		age  time.Duration
		want bool // removed?
	}{
		{"just inside TTL", 13 * 24 * time.Hour, false},
		{"just past TTL", 15 * 24 * time.Hour, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			path := writeArtifact(t, root, "o", "r", "probe.json", 8, time.Now().Add(-tt.age))

			_, err := SweepArtifactFiles(context.Background(), root, nil, ttl)
			require.NoError(t, err)
			_, statErr := os.Stat(path)
			if tt.want {
				assert.True(t, os.IsNotExist(statErr))
			} else {
				assert.NoError(t, statErr)
			}
		})
	}
}
