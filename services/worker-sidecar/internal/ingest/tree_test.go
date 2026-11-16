package ingest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestArchiveEnsureContract(t *testing.T) {
	tests := []struct {
		name         string
		handler      http.HandlerFunc
		wantOk       bool
		checkRequest bool
	}{
		{
			name: "successful ensure response 200",
			handler: func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, "/v1/archive/ensure", r.URL.Path)
				assert.Equal(t, "tok", r.Header.Get("x-internal-token"))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"dir":"/storage/repos/o/r/sha","fromCache":false}`))
			},
			wantOk:       true,
			checkRequest: true,
		},
		{
			name: "server error 502 falls back to false",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusBadGateway)
			},
			wantOk:       false,
			checkRequest: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(tt.handler)
			defer ts.Close()

			c := NewArchiveClient(ts.URL, "tok")
			ok := c.Ensure(context.Background(), "o", "r", "sha")
			assert.Equal(t, tt.wantOk, ok)
		})
	}
}

func TestTreeFromArchive(t *testing.T) {
	root := t.TempDir()
	dir := ArchiveDirFor(root, "o", "r", "sha")
	// 造布局：book/a.md + book/sub/b.ts + 根 README.md
	for _, f := range []string{"book/a.md", "book/sub/b.ts", "README.md"} {
		p := filepath.Join(dir, filepath.FromSlash(f))
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		require.NoError(t, os.WriteFile(p, []byte("x"), 0o644))
	}

	tests := []struct {
		name       string
		sha        string
		wantOk     bool
		wantTrees  int
		wantBlobs  int
		checkPaths []string
	}{
		{
			name:       "valid archive tree resolution",
			sha:        "sha",
			wantOk:     true,
			wantTrees:  2,
			wantBlobs:  3,
			checkPaths: []string{"book", "book/sub", "book/a.md", "book/sub/b.ts", "README.md"},
		},
		{
			name:   "missing archive resolution returns false",
			sha:    "missing",
			wantOk: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			nodes, ok := TreeFromArchive(root, "o", "r", tt.sha)
			assert.Equal(t, tt.wantOk, ok)
			if !tt.wantOk {
				return
			}

			trees, blobs := 0, 0
			paths := make(map[string]bool)
			for _, n := range nodes {
				paths[n.Path] = true
				if n.Type == "tree" {
					trees++
				} else {
					blobs++
					assert.Equal(t, int64(1), n.Size, "blob %s size mismatch", n.Path)
				}
			}

			assert.Equal(t, tt.wantTrees, trees)
			assert.Equal(t, tt.wantBlobs, blobs)
			for _, wantPath := range tt.checkPaths {
				assert.True(t, paths[wantPath], "missing path %s in tree nodes", wantPath)
			}
		})
	}

	t.Run("streaming and tree traversal pruning", func(t *testing.T) {
		visitedBlobs := 0
		streamOk := StreamTreeFromArchive(root, "o", "r", "sha", func(n GitNode) error {
			if n.Type == "blob" {
				visitedBlobs++
			}
			return nil
		})
		assert.True(t, streamOk)
		assert.Equal(t, 3, visitedBlobs)

		// SkipDirFn 剪枝测试：剪掉 book 目录
		prunedCount := 0
		WalkArchiveTree(root, "o", "r", "sha", WalkArchiveTreeOptions{
			SkipDirFn: func(relPath string) bool {
				return relPath == "book"
			},
		}, func(n GitNode) error {
			prunedCount++
			assert.NotEqual(t, "book/a.md", n.Path)
			assert.NotEqual(t, "book/sub/b.ts", n.Path)
			return nil
		})
		assert.Equal(t, 1, prunedCount, "only README.md should be visited when book is pruned")
	})
}

func TestResolveLatestSha(t *testing.T) {
	tests := []struct {
		name     string
		respJSON string
		wantSha  string
	}{
		{
			name:     "resolve commit sha from github api",
			respJSON: `{"sha":"abc123"}`,
			wantSha:  "abc123",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(tt.respJSON))
			}))
			defer ts.Close()

			cfg := LoadConfigFromEnv()
			cfg.GitHubAPIBase = ts.URL
			sha, err := ResolveLatestSha(context.Background(), cfg, "o", "r", "main")
			require.NoError(t, err)
			assert.Equal(t, tt.wantSha, sha)
		})
	}
}

func TestFetchRepoStars(t *testing.T) {
	tests := []struct {
		name      string
		respJSON  string
		wantStars int
	}{
		{
			name:      "fetch stargazers count from github api",
			respJSON:  `{"stargazers_count": 42100}`,
			wantStars: 42100,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(tt.respJSON))
			}))
			defer ts.Close()

			cfg := LoadConfigFromEnv()
			cfg.GitHubAPIBase = ts.URL
			stars, err := FetchRepoStars(context.Background(), cfg, "owner", "repo")
			require.NoError(t, err)
			assert.Equal(t, tt.wantStars, stars)
		})
	}
}
