package archive

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func testArchiveConfig(t *testing.T, storageRoot string) Config {
	t.Helper()
	return Config{
		ArchiveRoot:              storageRoot,
		GitHubAPIBase:            "http://127.0.0.1:1",
		UserAgent:                "test-agent",
		InternalToken:            "test-internal-token",
		EntryCapBytes:            1024 * 1024,
		ArchiveDownloadTimeoutMs: 5000,
	}
}

func testTarGz(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for name, content := range entries {
		err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content))})
		require.NoError(t, err)
		_, err = tw.Write([]byte(content))
		require.NoError(t, err)
	}
	require.NoError(t, tw.Close())
	require.NoError(t, gw.Close())
	return buf.Bytes()
}

func TestAssertSafeArchiveSegments(t *testing.T) {
	tests := []struct {
		name      string
		owner     string
		repo      string
		sha       string
		expectErr bool
	}{
		{
			name:      "standard short sha",
			owner:     "facebook",
			repo:      "react",
			sha:       "a1b2c3d",
			expectErr: false,
		},
		{
			name:      "special chars in owner and repo with 40-char sha",
			owner:     "a.b-c",
			repo:      "d_e",
			sha:       "0123456789abcdef0123456789abcdef01234567",
			expectErr: false,
		},
		{
			name:      "path traversal in owner",
			owner:     "../evil",
			repo:      "react",
			sha:       "a1b2c3d",
			expectErr: true,
		},
		{
			name:      "bare dotdot as owner segment",
			owner:     "..",
			repo:      "react",
			sha:       "a1b2c3d",
			expectErr: true,
		},
		{
			name:      "bare dot as owner segment",
			owner:     ".",
			repo:      "react",
			sha:       "a1b2c3d",
			expectErr: true,
		},
		{
			name:      "path traversal with slash in repo",
			owner:     "facebook",
			repo:      "react/nested",
			sha:       "a1b2c3d",
			expectErr: true,
		},
		{
			name:      "space in repo name",
			owner:     "owner",
			repo:      "re po",
			sha:       "a1b2c3d",
			expectErr: true,
		},
		{
			name:      "colon in repo name",
			owner:     "owner",
			repo:      "repo:name",
			sha:       "a1b2c3d",
			expectErr: true,
		},
		{
			name:      "path traversal in sha",
			owner:     "owner",
			repo:      "repo",
			sha:       "../etc",
			expectErr: true,
		},
		{
			name:      "sha too short (< 7 hex)",
			owner:     "owner",
			repo:      "repo",
			sha:       "abc12",
			expectErr: true,
		},
		{
			name:      "invalid hex characters in sha",
			owner:     "owner",
			repo:      "repo",
			sha:       "xyz1234",
			expectErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := AssertSafeArchiveSegments(tt.owner, tt.repo, tt.sha)
			if tt.expectErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestHandleArchiveEnsure_Auth(t *testing.T) {
	root := t.TempDir()
	cfg := testArchiveConfig(t, root)
	svc := NewEnsureService(cfg)
	h := NewHandler(cfg, svc, nil)
	ts := httptest.NewServer(h.testRoutes("test-internal-token"))
	defer ts.Close()

	tests := []struct {
		name       string
		token      string
		wantStatus int
	}{
		{
			name:       "1.14.1.1 missing token header returns 401",
			token:      "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "1.14.1.1 wrong token header returns 401",
			token:      "invalid-token",
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/archive/ensure", bytes.NewReader([]byte(`{"owner":"o","repo":"r","sha":"abc1234"}`)))
			require.NoError(t, err)
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()

			assert.Equal(t, tt.wantStatus, resp.StatusCode)
		})
	}
}

func TestHandleArchiveEnsure_StartupTokenRequired(t *testing.T) {
	tests := []struct {
		name        string
		cfg         Config
		wantErr     bool
		errContains string
	}{
		{
			name:        "1.14.1.2 missing INTERNAL_API_TOKEN rejects startup",
			cfg:         Config{DatabaseURL: "postgres://localhost/db", InternalToken: ""},
			wantErr:     true,
			errContains: "INTERNAL_API_TOKEN is not set",
		},
		{
			name:        "1.14.1.2 missing DATABASE_URL rejects startup",
			cfg:         Config{DatabaseURL: "", InternalToken: "secret"},
			wantErr:     true,
			errContains: "DATABASE_URL is not set",
		},
		{
			name:        "1.14.1.2 valid startup configuration passes",
			cfg:         Config{DatabaseURL: "postgres://localhost/db", InternalToken: "secret"},
			wantErr:     false,
			errContains: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cfg.ValidateStartup()
			if tt.wantErr {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.errContains)
			} else {
				require.NoError(t, err)
			}
		})
	}
}

func TestHandleArchiveEnsure_Validation(t *testing.T) {
	root := t.TempDir()
	cfg := testArchiveConfig(t, root)
	svc := NewEnsureService(cfg)
	h := NewHandler(cfg, svc, nil)
	ts := httptest.NewServer(h.testRoutes("test-internal-token"))
	defer ts.Close()

	tests := []struct {
		name       string
		method     string
		body       string
		wantStatus int
	}{
		{
			name:       "GET method not allowed",
			method:     http.MethodGet,
			body:       "",
			wantStatus: http.StatusMethodNotAllowed,
		},
		{
			name:       "malformed JSON returns 400",
			method:     http.MethodPost,
			body:       "{invalid-json",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing required fields returns 400",
			method:     http.MethodPost,
			body:       `{"owner":"","repo":"r","sha":"abc1234"}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "1.14.2.3 path traversal in owner returns 400",
			method:     http.MethodPost,
			body:       `{"owner":"../../evil","repo":"r","sha":"abc1234"}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "1.14.2.3 path traversal in sha returns 400",
			method:     http.MethodPost,
			body:       `{"owner":"o","repo":"r","sha":"../etc"}`,
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(tt.method, ts.URL+"/v1/archive/ensure", bytes.NewReader([]byte(tt.body)))
			require.NoError(t, err)
			req.Header.Set("x-internal-token", "test-internal-token")

			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()

			assert.Equal(t, tt.wantStatus, resp.StatusCode)
		})
	}
}

func TestArchiveEnsure_MaliciousTar(t *testing.T) {
	root := t.TempDir()
	sha := "0123456789abcdef0123456789abcdef01234567"

	body := testTarGz(t, map[string]string{
		"owner-repo-" + sha + "/docs/guide.md":        "valid content",
		"owner-repo-" + sha + "/a..b.md":              "double-dot filename is legal",
		"owner-repo-" + sha + "/../../evil.txt":       "pwn relative",
		"owner-repo-" + sha + "/./../../evil-dot.txt": "pwn dot segment",
		"/evil_abs.txt": "pwn abs",
	})

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-gzip")
		_, _ = w.Write(body)
	}))
	defer gh.Close()

	cfg := testArchiveConfig(t, root)
	cfg.GitHubAPIBase = gh.URL
	svc := NewEnsureService(cfg)

	dir, fromCache, err := svc.Ensure(context.Background(), "owner", "repo", sha, 0, "")
	require.NoError(t, err)
	assert.NotEmpty(t, dir)
	assert.False(t, fromCache)

	assert.FileExists(t, filepath.Join(dir, "docs", "guide.md"))
	content, _ := os.ReadFile(filepath.Join(dir, "docs", "guide.md"))
	assert.Equal(t, "valid content", string(content))
	assert.FileExists(t, filepath.Join(dir, "a..b.md"))

	assert.NoFileExists(t, filepath.Join(root, "evil.txt"))
	assert.NoFileExists(t, filepath.Join(root, "evil-dot.txt"))
	assert.NoFileExists(t, filepath.Join(dir, "..", "evil.txt"))
	assert.NoFileExists(t, filepath.Join(root, "evil_abs.txt"))
}

func TestArchiveEnsure_CapBreaker(t *testing.T) {
	tests := []struct {
		name           string
		sizeHintBytes  int64
		contentLength  int64
		tarPayloadSize int
		expectSkipped  bool
	}{
		{
			name:           "1.14.2.2 level 1 size hint exceeds cap skips without download",
			sizeHintBytes:  2 * 1024 * 1024,
			contentLength:  -1,
			tarPayloadSize: 100,
			expectSkipped:  true,
		},
		{
			name:           "level 2 content length header exceeds cap",
			sizeHintBytes:  0,
			contentLength:  2 * 1024 * 1024,
			tarPayloadSize: 100,
			expectSkipped:  true,
		},
		{
			name:           "level 3 cumulative extracted size exceeds cap",
			sizeHintBytes:  0,
			contentLength:  -1,
			tarPayloadSize: 2 * 1024 * 1024,
			expectSkipped:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			sha := "0123456789abcdef0123456789abcdef01234567"
			downloadAttempted := false

			gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				downloadAttempted = true
				if tt.contentLength > 0 {
					w.Header().Set("Content-Length", fmt.Sprintf("%d", tt.contentLength))
				}
				w.Header().Set("Content-Type", "application/x-gzip")
				payload := bytes.Repeat([]byte("A"), tt.tarPayloadSize)
				tarData := testTarGz(t, map[string]string{
					"owner-repo-" + sha + "/large.bin": string(payload),
				})
				_, _ = w.Write(tarData)
			}))
			defer gh.Close()

			cfg := testArchiveConfig(t, root)
			cfg.GitHubAPIBase = gh.URL
			cfg.EntryCapBytes = 1024 * 1024
			svc := NewEnsureService(cfg)

			dir, fromCache, err := svc.Ensure(context.Background(), "owner", "repo", sha, tt.sizeHintBytes, "")
			require.NoError(t, err)
			assert.Empty(t, dir, "must return empty dir on over-cap skip")
			assert.False(t, fromCache)

			if tt.sizeHintBytes > cfg.EntryCapBytes {
				assert.False(t, downloadAttempted, "must not attempt download when size hint exceeds cap")
			}

			finalDir, err := svc.ArchiveDirFor("owner", "repo", sha)
			require.NoError(t, err)
			assert.NoDirExists(t, finalDir)
		})
	}
}

func TestArchiveEnsure_CacheHit(t *testing.T) {
	root := t.TempDir()
	sha := "0123456789abcdef0123456789abcdef01234567"
	var downloadCount int32

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&downloadCount, 1)
		w.Header().Set("Content-Type", "application/x-gzip")
		_, _ = w.Write(testTarGz(t, map[string]string{
			"owner-repo-" + sha + "/hello.txt": "world",
		}))
	}))
	defer gh.Close()

	cfg := testArchiveConfig(t, root)
	cfg.GitHubAPIBase = gh.URL
	svc := NewEnsureService(cfg)

	dir1, fromCache1, err := svc.Ensure(context.Background(), "owner", "repo", sha, 0, "")
	require.NoError(t, err)
	assert.NotEmpty(t, dir1)
	assert.False(t, fromCache1)
	assert.FileExists(t, filepath.Join(dir1, "hello.txt"))
	assert.Equal(t, int32(1), atomic.LoadInt32(&downloadCount))

	dir2, fromCache2, err := svc.Ensure(context.Background(), "owner", "repo", sha, 0, "")
	require.NoError(t, err)
	assert.Equal(t, dir1, dir2)
	assert.True(t, fromCache2)
	assert.Equal(t, int32(1), atomic.LoadInt32(&downloadCount), "download count should remain 1 on cache hit")

	meta, err := NewMetaStore(root).Load()
	require.NoError(t, err)
	entry, ok := meta[archiveKey("owner", "repo", sha)]
	require.True(t, ok)
	assert.Equal(t, int64(1), entry.Hits)
	assert.Greater(t, entry.Size, int64(0))
}

func TestArchiveEnsure_Singleflight(t *testing.T) {
	root := t.TempDir()
	sha := "0123456789abcdef0123456789abcdef01234567"
	var downloadCount int32

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&downloadCount, 1)
		time.Sleep(50 * time.Millisecond)
		w.Header().Set("Content-Type", "application/x-gzip")
		_, _ = w.Write(testTarGz(t, map[string]string{
			"owner-repo-" + sha + "/concurrency.txt": "singleflight-ok",
		}))
	}))
	defer gh.Close()

	cfg := testArchiveConfig(t, root)
	cfg.GitHubAPIBase = gh.URL
	svc := NewEnsureService(cfg)

	const concurrency = 10
	var wg sync.WaitGroup
	wg.Add(concurrency)
	dirs := make([]string, concurrency)
	errs := make([]error, concurrency)

	for i := 0; i < concurrency; i++ {
		idx := i
		go func() {
			defer wg.Done()
			d, _, err := svc.Ensure(context.Background(), "owner", "repo", sha, 0, "")
			dirs[idx] = d
			errs[idx] = err
		}()
	}
	wg.Wait()

	for i := 0; i < concurrency; i++ {
		require.NoError(t, errs[i])
		assert.NotEmpty(t, dirs[i])
		assert.Equal(t, dirs[0], dirs[i])
	}

	assert.Equal(t, int32(1), atomic.LoadInt32(&downloadCount), "singleflight must deduplicate concurrent downloads to exactly 1")
}

func TestArchiveEnsure_NegativeCacheMemo(t *testing.T) {
	root := t.TempDir()
	sha := "0123456789abcdef0123456789abcdef01234567"
	var attempts int32

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&attempts, 1)
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer gh.Close()

	cfg := testArchiveConfig(t, root)
	cfg.GitHubAPIBase = gh.URL
	svc := NewEnsureService(cfg)

	shortCtx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	dir1, fromCache1, err1 := svc.Ensure(shortCtx, "owner", "repo", sha, 0, "")
	require.NoError(t, err1)
	assert.Empty(t, dir1)
	assert.False(t, fromCache1)
	assert.Equal(t, int32(1), atomic.LoadInt32(&attempts))

	dir2, fromCache2, err2 := svc.Ensure(context.Background(), "owner", "repo", sha, 0, "")
	require.NoError(t, err2)
	assert.Empty(t, dir2)
	assert.False(t, fromCache2)
	assert.Equal(t, int32(1), atomic.LoadInt32(&attempts), "negative cache memo must prevent immediate retry")
}

func TestHandleArchiveEnsure_E2E(t *testing.T) {
	root := t.TempDir()
	sha := "0123456789abcdef0123456789abcdef01234567"

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-gzip")
		_, _ = w.Write(testTarGz(t, map[string]string{
			"owner-repo-" + sha + "/index.md": "# Title",
		}))
	}))
	defer gh.Close()

	cfg := testArchiveConfig(t, root)
	cfg.GitHubAPIBase = gh.URL
	svc := NewEnsureService(cfg)
	h := NewHandler(cfg, svc, nil)
	ts := httptest.NewServer(h.testRoutes("test-internal-token"))
	defer ts.Close()

	payload, _ := json.Marshal(ArchiveEnsureRequest{
		Owner: "owner",
		Repo:  "repo",
		Sha:   sha,
	})

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/archive/ensure", bytes.NewReader(payload))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-internal-token", "test-internal-token")

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var result ArchiveEnsureResponse
	err = json.NewDecoder(resp.Body).Decode(&result)
	require.NoError(t, err)
	require.NotNil(t, result.Dir)
	assert.False(t, result.FromCache)
	assert.Contains(t, *result.Dir, sha)
	assert.FileExists(t, filepath.Join(*result.Dir, "index.md"))
}

func TestArchiveEnsure_CanceledContextDoesNotPoisonNegativeCache(t *testing.T) {
	root := t.TempDir()
	sha := "0123456789abcdef0123456789abcdef01234567"
	var attempts int32

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&attempts, 1)
		time.Sleep(30 * time.Millisecond)
		w.Header().Set("Content-Type", "application/x-gzip")
		_, _ = w.Write(testTarGz(t, map[string]string{
			"owner-repo-" + sha + "/hello.txt": "world",
		}))
	}))
	defer gh.Close()

	cfg := testArchiveConfig(t, root)
	cfg.GitHubAPIBase = gh.URL
	svc := NewEnsureService(cfg)

	cancelCtx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(5 * time.Millisecond)
		cancel()
	}()

	_, _, err1 := svc.Ensure(cancelCtx, "owner", "repo", sha, 0, "")
	assert.Error(t, err1, "must return error upon client cancellation")
	assert.ErrorIs(t, err1, context.Canceled)

	dir2, fromCache2, err2 := svc.Ensure(context.Background(), "owner", "repo", sha, 0, "")
	require.NoError(t, err2)
	assert.NotEmpty(t, dir2)
	assert.False(t, fromCache2)
	assert.FileExists(t, filepath.Join(dir2, "hello.txt"))
}

func TestArchiveEnsure_RenameCollisionRecovery(t *testing.T) {
	root := t.TempDir()
	sha := "0123456789abcdef0123456789abcdef01234567"

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-gzip")
		_, _ = w.Write(testTarGz(t, map[string]string{
			"owner-repo-" + sha + "/file.txt": "downloaded",
		}))
	}))
	defer gh.Close()

	cfg := testArchiveConfig(t, root)
	cfg.GitHubAPIBase = gh.URL
	svc := NewEnsureService(cfg)

	finalDir, err := svc.ArchiveDirFor("owner", "repo", sha)
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(finalDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(finalDir, "existing.txt"), []byte("already-here"), 0o644))

	dir, _, err := svc.Ensure(context.Background(), "owner", "repo", sha, 0, "")
	require.NoError(t, err)
	assert.Equal(t, finalDir, dir)
	assert.FileExists(t, filepath.Join(dir, "existing.txt"))
}

func TestArchiveEnsure_MaliciousTarBackslashAndColon(t *testing.T) {
	root := t.TempDir()
	sha := "0123456789abcdef0123456789abcdef01234567"

	body := testTarGz(t, map[string]string{
		"owner-repo-" + sha + "/valid.txt":       "safe",
		"owner-repo-" + sha + "/..\\..\\win.txt": "win traversal",
		"owner-repo-" + sha + "/C:drive.txt":     "drive escape",
		"owner-repo-" + sha + "/subdir:colon":    "colon escape",
	})

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-gzip")
		_, _ = w.Write(body)
	}))
	defer gh.Close()

	cfg := testArchiveConfig(t, root)
	cfg.GitHubAPIBase = gh.URL
	svc := NewEnsureService(cfg)

	dir, _, err := svc.Ensure(context.Background(), "owner", "repo", sha, 0, "")
	require.NoError(t, err)
	assert.NotEmpty(t, dir)

	assert.FileExists(t, filepath.Join(dir, "valid.txt"))
	assert.NoFileExists(t, filepath.Join(root, "win.txt"))
	assert.NoFileExists(t, filepath.Join(root, "drive.txt"))
}

func TestArchiveEnsure_StartupCleanupOrphanMetadata(t *testing.T) {
	root := t.TempDir()
	cfg := testArchiveConfig(t, root)
	svc := NewEnsureService(cfg)

	orphanDir := filepath.Join(root, "orphan.tmp-12345")
	require.NoError(t, os.MkdirAll(orphanDir, 0o755))
	orphanMetaTmp := filepath.Join(root, "metadata.json.tmp-99999")
	require.NoError(t, os.WriteFile(orphanMetaTmp, []byte("{}"), 0o644))

	svc.cleanupOrphanTmpDirs()

	assert.NoDirExists(t, orphanDir, "orphan tmp directory must be cleaned")
	assert.NoFileExists(t, orphanMetaTmp, "orphan metadata tmp file must be cleaned")
}

func TestArchiveEnsure_IgnoredPayloadExtsSkipped(t *testing.T) {
	root := t.TempDir()
	sha := "0123456789abcdef0123456789abcdef01234567"

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-gzip")
		tarData := testTarGz(t, map[string]string{
			"owner-repo-" + sha + "/src/main.go":       "package main\nfunc main() {}",
			"owner-repo-" + sha + "/model.safetensors": "massive binary weights simulation",
			"owner-repo-" + sha + "/demo.mp4":          "video simulation",
			"owner-repo-" + sha + "/bundle.onnx":       "onnx model simulation",
		})
		_, _ = w.Write(tarData)
	}))
	defer gh.Close()

	cfg := testArchiveConfig(t, root)
	cfg.GitHubAPIBase = gh.URL
	svc := NewEnsureService(cfg)

	dir, _, err := svc.Ensure(context.Background(), "owner", "repo", sha, 0, "")
	require.NoError(t, err)
	assert.NotEmpty(t, dir)

	assert.FileExists(t, filepath.Join(dir, "src/main.go"))

	assert.NoFileExists(t, filepath.Join(dir, "model.safetensors"))
	assert.NoFileExists(t, filepath.Join(dir, "demo.mp4"))
	assert.NoFileExists(t, filepath.Join(dir, "bundle.onnx"))
}

func TestArchiveEnsure_EnsureWithCap(t *testing.T) {
	root := t.TempDir()
	sha := "0123456789abcdef0123456789abcdef01234567"

	payload := bytes.Repeat([]byte("X"), 60*1024)

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-gzip")
		tarData := testTarGz(t, map[string]string{
			"owner-repo-" + sha + "/large.txt": string(payload),
		})
		_, _ = w.Write(tarData)
	}))
	defer gh.Close()

	cfg := testArchiveConfig(t, root)
	cfg.GitHubAPIBase = gh.URL
	cfg.EntryCapBytes = 50 * 1024
	svc := NewEnsureService(cfg)

	dir, _, err := svc.Ensure(context.Background(), "owner", "repo", sha, 0, "")
	require.NoError(t, err)
	assert.Empty(t, dir, "default 50KB cap should skip 60KB payload")

	dir2, _, err := svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024)
	require.NoError(t, err)
	assert.NotEmpty(t, dir2, "200KB cap should successfully extract 60KB payload")
	assert.FileExists(t, filepath.Join(dir2, "large.txt"))
}

func TestArchiveEnsure_ZipBombSentinelBlocksAllCapWidths(t *testing.T) {
	root := t.TempDir()
	sha := "0123456789abcdef0123456789abcdef01234567"
	var attempts int32

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.Header().Set("Content-Type", "application/x-gzip")
		payload := bytes.Repeat([]byte("A"), 10*1024*1024)
		tarData := testTarGz(t, map[string]string{
			"owner-repo-" + sha + "/bomb.bin": string(payload),
		})
		_, _ = w.Write(tarData)
	}))
	defer gh.Close()

	cfg := testArchiveConfig(t, root)
	cfg.GitHubAPIBase = gh.URL
	cfg.EntryCapBytes = 100 * 1024 * 1024
	svc := NewEnsureService(cfg)

	dir1, fromCache1, err1 := svc.Ensure(context.Background(), "owner", "repo", sha, 0, "")
	require.NoError(t, err1, "zip-bomb must convert to skip (dir empty, no error)")
	assert.Empty(t, dir1)
	assert.False(t, fromCache1)
	assert.Equal(t, int32(1), atomic.LoadInt32(&attempts))

	dir2, fromCache2, err2 := svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024*1024)
	require.NoError(t, err2)
	assert.Empty(t, dir2)
	assert.False(t, fromCache2)
	assert.Equal(t, int32(1), atomic.LoadInt32(&attempts), "zip-bomb sentinel cap must block retry under any wider cap")
}

func detectCaseInsensitiveFS(t *testing.T, root string) bool {
	t.Helper()
	probe := filepath.Join(root, "CASE-PROBE")
	if err := os.WriteFile(probe, []byte("x"), 0o644); err != nil {
		return false
	}
	defer os.Remove(probe)
	_, err := os.Stat(filepath.Join(root, "case-probe"))
	return err == nil
}

func TestArchiveEnsure_NormalizeLegacyCaseDirs(t *testing.T) {
	sha := "0123456789abcdef0123456789abcdef01234567"

	t.Run("mixed-case legacy dir becomes hittable via lowercase path without data loss", func(t *testing.T) {
		root := t.TempDir()
		legacyDir := filepath.Join(root, "Owner", "Repo", sha)
		require.NoError(t, os.MkdirAll(legacyDir, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(legacyDir, "index.md"), []byte("x"), 0o644))

		cfg := testArchiveConfig(t, root)
		svc := NewEnsureService(cfg)
		svc.normalizeLegacyCaseDirs()

		lowerFile := filepath.Join(root, "owner", "repo", sha, "index.md")
		assert.FileExists(t, lowerFile)
		content, err := os.ReadFile(lowerFile)
		require.NoError(t, err)
		assert.Equal(t, "x", string(content))

		if !detectCaseInsensitiveFS(t, root) {
			assert.NoDirExists(t, filepath.Join(root, "Owner"))
		}
	})

	t.Run("collision with existing lowercase copy reclaims the mixed-case duplicate only on case-sensitive fs", func(t *testing.T) {
		root := t.TempDir()
		lowerDir := filepath.Join(root, "owner", "repo", sha)
		legacyDir := filepath.Join(root, "Owner", "repo", sha)
		require.NoError(t, os.MkdirAll(lowerDir, 0o755))
		require.NoError(t, os.MkdirAll(legacyDir, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(lowerDir, "index.md"), []byte("fresh"), 0o644))

		survive := func() {
			content, err := os.ReadFile(filepath.Join(lowerDir, "index.md"))
			require.NoError(t, err)
			assert.Equal(t, "fresh", string(content))
		}

		cfg := testArchiveConfig(t, root)
		svc := NewEnsureService(cfg)
		svc.normalizeLegacyCaseDirs()

		if detectCaseInsensitiveFS(t, root) {
			survive()
			return
		}
		assert.DirExists(t, lowerDir)
		assert.NoDirExists(t, legacyDir, "mixed-case duplicate must be reclaimed when lowercase copy exists")
		survive()
	})
}

func TestArchiveEnsure_ScopedUnpack(t *testing.T) {
	tests := []struct {
		name          string
		scope         string
		expectedDirs  []string
		absentDirs    []string
		expectedFiles []string
		absentFiles   []string
	}{
		{
			name:  "scoped unpack target audio subvolume only",
			scope: "src/audio",
			expectedDirs: []string{
				"src",
				"src/audio",
				"src/audio/dsp",
			},
			absentDirs: []string{
				"src/video",
				"docs",
				"tests",
			},
			expectedFiles: []string{
				"README.md",
				"package.json",
				"src/audio/engine.go",
				"src/audio/dsp/filter.go",
			},
			absentFiles: []string{
				"src/video/player.go",
				"src/video/codec.go",
				"docs/guide.md",
				"tests/test.go",
			},
		},
		{
			name:  "scoped unpack target video subvolume with slash padding",
			scope: "/src/video/",
			expectedDirs: []string{
				"src",
				"src/video",
			},
			absentDirs: []string{
				"src/audio",
				"docs",
				"tests",
			},
			expectedFiles: []string{
				"README.md",
				"package.json",
				"src/video/player.go",
				"src/video/codec.go",
			},
			absentFiles: []string{
				"src/audio/engine.go",
				"docs/guide.md",
				"tests/test.go",
			},
		},
		{
			name:  "full unpack without scope extracts everything",
			scope: "",
			expectedDirs: []string{
				"src",
				"src/audio",
				"src/video",
				"docs",
				"tests",
			},
			expectedFiles: []string{
				"README.md",
				"package.json",
				"src/audio/engine.go",
				"src/video/player.go",
				"docs/guide.md",
				"tests/test.go",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			sha := "0123456789abcdef0123456789abcdef01234567"

			gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/x-gzip")
				tarData := testTarGz(t, map[string]string{
					"owner-repo-" + sha + "/README.md":               "# Global Readme\n",
					"owner-repo-" + sha + "/package.json":            "{\"name\":\"root\"}\n",
					"owner-repo-" + sha + "/src/audio/engine.go":     "package audio\n",
					"owner-repo-" + sha + "/src/audio/dsp/filter.go": "package dsp\n",
					"owner-repo-" + sha + "/src/video/player.go":     "package video\n",
					"owner-repo-" + sha + "/src/video/codec.go":      "package video\n",
					"owner-repo-" + sha + "/docs/guide.md":           "# Guide\n",
					"owner-repo-" + sha + "/tests/test.go":           "package test\n",
				})
				_, _ = w.Write(tarData)
			}))
			defer gh.Close()

			cfg := testArchiveConfig(t, root)
			cfg.GitHubAPIBase = gh.URL
			svc := NewEnsureService(cfg)

			var dir string
			var fromCache bool
			var err error
			if tt.scope != "" {
				dir, fromCache, err = svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024, tt.scope)
			} else {
				dir, fromCache, err = svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024)
			}
			require.NoError(t, err)
			assert.NotEmpty(t, dir)
			assert.False(t, fromCache, "首次解压应为未命中缓存")

			for _, f := range tt.expectedFiles {
				assert.FileExists(t, filepath.Join(dir, f), "expected file must exist: %s", f)
			}
			for _, f := range tt.absentFiles {
				assert.NoFileExists(t, filepath.Join(dir, f), "absent file must NOT exist on disk: %s", f)
			}
			for _, d := range tt.expectedDirs {
				assert.DirExists(t, filepath.Join(dir, d), "expected dir must exist: %s", d)
			}
			for _, d := range tt.absentDirs {
				assert.NoDirExists(t, filepath.Join(dir, d), "absent dir must NOT exist on disk: %s", d)
			}

			var dir2 string
			if tt.scope != "" {
				dir2, fromCache, err = svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024, tt.scope)
			} else {
				dir2, fromCache, err = svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024)
			}
			require.NoError(t, err)
			assert.Equal(t, dir, dir2)
			assert.True(t, fromCache, "第二次相同请求应命中缓存")
		})
	}

	t.Run("secondary scoped unpack merges without losing existing files", func(t *testing.T) {
		root := t.TempDir()
		sha := "0123456789abcdef0123456789abcdef01234567"

		gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/x-gzip")
			tarData := testTarGz(t, map[string]string{
				"owner-repo-" + sha + "/README.md":           "# Readme\n",
				"owner-repo-" + sha + "/src/audio/engine.go": "package audio\n",
				"owner-repo-" + sha + "/src/video/player.go": "package video\n",
			})
			_, _ = w.Write(tarData)
		}))
		defer gh.Close()

		cfg := testArchiveConfig(t, root)
		cfg.GitHubAPIBase = gh.URL
		svc := NewEnsureService(cfg)

		dir1, fromCache1, err := svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024, "src/audio")
		require.NoError(t, err)
		assert.False(t, fromCache1)
		assert.FileExists(t, filepath.Join(dir1, "src/audio/engine.go"))
		assert.NoFileExists(t, filepath.Join(dir1, "src/video/player.go"))

		dir2, fromCache2, err := svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024, "src/video")
		require.NoError(t, err)
		assert.False(t, fromCache2)
		assert.Equal(t, dir1, dir2)
		assert.FileExists(t, filepath.Join(dir2, "src/audio/engine.go"), "原有的 src/audio 源码不能被覆盖丢失")
		assert.FileExists(t, filepath.Join(dir2, "src/video/player.go"), "新解压的 src/video 源码应成功落盘")
	})

	t.Run("parent scope after child scope must not falsely hit cache", func(t *testing.T) {
		root := t.TempDir()
		sha := "0123456789abcdef0123456789abcdef01234567"

		gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/x-gzip")
			tarData := testTarGz(t, map[string]string{
				"owner-repo-" + sha + "/README.md":           "# Readme\n",
				"owner-repo-" + sha + "/src/audio/engine.go": "package audio\n",
				"owner-repo-" + sha + "/src/video/player.go": "package video\n",
			})
			_, _ = w.Write(tarData)
		}))
		defer gh.Close()

		cfg := testArchiveConfig(t, root)
		cfg.GitHubAPIBase = gh.URL
		svc := NewEnsureService(cfg)

		dir1, fromCache1, err := svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024, "src/audio")
		require.NoError(t, err)
		assert.False(t, fromCache1)
		assert.FileExists(t, filepath.Join(dir1, "src/audio/engine.go"))
		assert.NoFileExists(t, filepath.Join(dir1, "src/video/player.go"))

		dir2, fromCache2, err := svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024, "src")
		require.NoError(t, err)
		assert.False(t, fromCache2, "父作用域请求必须触发实际解压，不得误判缓存命中")
		assert.Equal(t, dir1, dir2)
		assert.FileExists(t, filepath.Join(dir2, "src/video/player.go"), "父作用域解压后应包含完整文件")
	})

	t.Run("full unpack followed by scoped unpack preserves full unpack markerless state", func(t *testing.T) {
		root := t.TempDir()
		sha := "0123456789abcdef0123456789abcdef01234567"

		gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/x-gzip")
			tarData := testTarGz(t, map[string]string{
				"owner-repo-" + sha + "/README.md":           "# Readme\n",
				"owner-repo-" + sha + "/src/audio/engine.go": "package audio\n",
				"owner-repo-" + sha + "/src/video/player.go": "package video\n",
			})
			_, _ = w.Write(tarData)
		}))
		defer gh.Close()

		cfg := testArchiveConfig(t, root)
		cfg.GitHubAPIBase = gh.URL
		svc := NewEnsureService(cfg)

		dir1, fromCache1, err := svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024)
		require.NoError(t, err)
		assert.False(t, fromCache1)
		assert.NoFileExists(t, filepath.Join(dir1, scopedMarkerFile), "全量解压目录不应有局部标记")

		dir2, fromCache2, err := svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024, "src/audio")
		require.NoError(t, err)
		assert.True(t, fromCache2, "全量就绪时局部解压请求应命中缓存")
		assert.Equal(t, dir1, dir2)
		assert.NoFileExists(t, filepath.Join(dir2, scopedMarkerFile), "命中全量时不应被错误写入局部标记")

		dir3, fromCache3, err := svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024)
		require.NoError(t, err)
		assert.True(t, fromCache3, "全量解压必须仍然命中缓存，未被污染")
		assert.Equal(t, dir1, dir3)
	})

	t.Run("scoped unpack preserves manifest variants and licenses", func(t *testing.T) {
		root := t.TempDir()
		sha := "0123456789abcdef0123456789abcdef01234567"

		gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/x-gzip")
			tarData := testTarGz(t, map[string]string{
				"owner-repo-" + sha + "/LICENSE":             "MIT\n",
				"owner-repo-" + sha + "/requirements.txt":    "requests\n",
				"owner-repo-" + sha + "/Cargo.lock":          "# lock\n",
				"owner-repo-" + sha + "/pnpm-workspace.yaml": "packages:\n",
				"owner-repo-" + sha + "/src/audio/engine.go": "package audio\n",
				"owner-repo-" + sha + "/other/ignored.py":    "print(1)\n",
			})
			_, _ = w.Write(tarData)
		}))
		defer gh.Close()

		cfg := testArchiveConfig(t, root)
		cfg.GitHubAPIBase = gh.URL
		svc := NewEnsureService(cfg)

		dir, fromCache, err := svc.EnsureWithCap(context.Background(), "owner", "repo", sha, 0, "", 200*1024, "src/audio")
		require.NoError(t, err)
		assert.False(t, fromCache)
		assert.FileExists(t, filepath.Join(dir, "LICENSE"), "根 LICENSE 必须保留")
		assert.FileExists(t, filepath.Join(dir, "requirements.txt"), "根 requirements.txt 必须保留")
		assert.FileExists(t, filepath.Join(dir, "Cargo.lock"), "根 Cargo.lock 必须保留")
		assert.FileExists(t, filepath.Join(dir, "pnpm-workspace.yaml"), "根 pnpm-workspace.yaml 必须保留")
		assert.FileExists(t, filepath.Join(dir, "src/audio/engine.go"), "目标子卷文件必须保留")
		assert.NoFileExists(t, filepath.Join(dir, "other/ignored.py"), "非目标子卷文件绝不落盘")
	})
}

func TestFormatSpeed(t *testing.T) {
	tests := []struct {
		name     string
		bps      float64
		expected string
	}{
		{name: "zero speed", bps: 0, expected: "0 B/s"},
		{name: "negative speed", bps: -100, expected: "0 B/s"},
		{name: "NaN speed", bps: math.NaN(), expected: "0 B/s"},
		{name: "positive Inf speed", bps: math.Inf(1), expected: "0 B/s"},
		{name: "negative Inf speed", bps: math.Inf(-1), expected: "0 B/s"},
		{name: "bytes per sec", bps: 512, expected: "512 B/s"},
		{name: "boundary 1024 B/s", bps: 1024, expected: "1.0 KB/s"},
		{name: "kilobytes per sec", bps: 500 * 1024, expected: "500.0 KB/s"},
		{name: "megabytes per sec", bps: 8.2 * 1024 * 1024, expected: "8.2 MB/s"},
		{name: "gigabytes per sec", bps: 1.5 * 1024 * 1024 * 1024, expected: "1.5 GB/s"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := FormatSpeed(tt.bps)
			assert.Equal(t, tt.expected, res)
		})
	}
}

func TestProgressTracker_EMASpeedAndPercent(t *testing.T) {
	tests := []struct {
		name          string
		contentLength int64
		sizeHintBytes int64
		simulateReads []struct {
			bytes int64
			delay time.Duration
		}
		testStallDecay bool
		wantPercent    float64
	}{
		{
			name:          "ContentLength percent calculation with EMA smoothing",
			contentLength: 1000,
			sizeHintBytes: 0,
			simulateReads: []struct {
				bytes int64
				delay time.Duration
			}{
				{bytes: 500, delay: 60 * time.Millisecond},
			},
			wantPercent: 50.0,
		},
		{
			name:          "sizeHint percent calculation when ContentLength absent",
			contentLength: 0,
			sizeHintBytes: 2000,
			simulateReads: []struct {
				bytes int64
				delay time.Duration
			}{
				{bytes: 1000, delay: 60 * time.Millisecond},
			},
			wantPercent: 50.0,
		},
		{
			name:          "asymptotic percent when both ContentLength and sizeHint absent",
			contentLength: 0,
			sizeHintBytes: 0,
			simulateReads: []struct {
				bytes int64
				delay time.Duration
			}{
				{bytes: 5 * 1024 * 1024, delay: 60 * time.Millisecond},
			},
			wantPercent: 31.66,
		},
		{
			name:          "stall decay smoothly reduces speed during read pause",
			contentLength: 10000,
			sizeHintBytes: 0,
			simulateReads: []struct {
				bytes int64
				delay time.Duration
			}{
				{bytes: 2000, delay: 30 * time.Millisecond},
				{bytes: 2000, delay: 30 * time.Millisecond},
			},
			testStallDecay: true,
			wantPercent:    40.0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var recordedProgress []Progress
			tracker := NewProgressTracker(tt.contentLength, tt.sizeHintBytes, func(p Progress) {
				recordedProgress = append(recordedProgress, p)
			})
			tracker.sampleInterval = 20 * time.Millisecond
			tracker.notifyInterval = 20 * time.Millisecond

			for _, sr := range tt.simulateReads {
				time.Sleep(sr.delay)
				tracker.UpdateDownloaded(sr.bytes)
				if tt.sizeHintBytes > 0 {
					tracker.AddExtracted(sr.bytes)
				}
			}

			snap := tracker.Snapshot()
			if tt.wantPercent > 0 {
				assert.InDelta(t, tt.wantPercent, snap.Percent, 1.5)
			}
			assert.NotEmpty(t, snap.SpeedFormatted)

			if tt.testStallDecay {
				activeSpeed := snap.SpeedBps
				assert.Greater(t, activeSpeed, 0.0)
				for i := 0; i < 4; i++ {
					time.Sleep(25 * time.Millisecond)
					tracker.Snapshot()
				}
				decayedSnap := tracker.Snapshot()
				assert.Less(t, decayedSnap.SpeedBps, activeSpeed, "停顿无新增数据时平滑速度必须显著衰减")
			}

			tracker.Finish()
			finalSnap := tracker.Snapshot()
			assert.Equal(t, 100.0, finalSnap.Percent)
		})
	}
}

func TestArchiveCall_PanicResilience(t *testing.T) {
	c := &archiveCall{done: make(chan struct{})}
	var calledNormal bool
	c.addCallback(func(p Progress) {
		panic("simulated callback panic")
	})
	c.addCallback(func(p Progress) {
		calledNormal = true
	})

	assert.NotPanics(t, func() {
		c.broadcast(Progress{Percent: 50.0})
	}, "第三方回调发生 panic 时 broadcast 必须安全 recover 绝不导致宿主进程崩溃")
	assert.True(t, calledNormal, "异常回调后的正常回调仍应被顺利执行")
}

func TestProgressReader_Streaming(t *testing.T) {
	data := []byte("hello world progress streaming test")
	tracker := NewProgressTracker(int64(len(data)), 0, nil)
	pr := newProgressReader(bytes.NewReader(data), tracker)

	buf := make([]byte, 10)
	n1, err := pr.Read(buf)
	require.NoError(t, err)
	assert.Equal(t, 10, n1)
	assert.Equal(t, int64(10), pr.TotalRead())
	assert.Equal(t, int64(10), tracker.TotalRead())

	rest, err := io.ReadAll(pr)
	require.NoError(t, err)
	assert.Equal(t, len(data)-10, len(rest))
	assert.Equal(t, int64(len(data)), pr.TotalRead())
	assert.Equal(t, int64(len(data)), tracker.TotalRead())
}

func TestArchiveEnsure_ProgressCallback(t *testing.T) {
	tests := []struct {
		name         string
		withContext  bool
		useDirectAPI bool
	}{
		{
			name:        "progress callback via context on EnsureWithCap",
			withContext: true,
		},
		{
			name:         "progress callback via EnsureWithProgress",
			useDirectAPI: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			sha := "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"

			gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/x-gzip")
				tarData := testTarGz(t, map[string]string{
					"owner-repo-" + sha + "/README.md":  "# Test\n",
					"owner-repo-" + sha + "/src/lib.rs": "pub fn hello() {}\n",
				})
				w.Header().Set("Content-Length", fmt.Sprintf("%d", len(tarData)))
				_, _ = w.Write(tarData)
			}))
			defer gh.Close()

			cfg := testArchiveConfig(t, root)
			cfg.GitHubAPIBase = gh.URL
			svc := NewEnsureService(cfg)

			var mu sync.Mutex
			var updates []Progress
			cb := func(p Progress) {
				mu.Lock()
				defer mu.Unlock()
				updates = append(updates, p)
			}

			var dir string
			var fromCache bool
			var err error

			if tt.useDirectAPI {
				dir, fromCache, err = svc.EnsureWithProgress(context.Background(), "owner", "repo", sha, 0, "", 200*1024, cb)
			} else {
				ctx := WithProgress(context.Background(), cb)
				dir, fromCache, err = svc.EnsureWithCap(ctx, "owner", "repo", sha, 0, "", 200*1024)
			}

			require.NoError(t, err)
			assert.False(t, fromCache)
			assert.DirExists(t, dir)

			mu.Lock()
			count := len(updates)
			require.Greater(t, count, 0, "进度回调必须至少被调用一次")
			last := updates[count-1]
			mu.Unlock()

			assert.Equal(t, 100.0, last.Percent, "最终进度必须达到 100%")
			assert.NotEmpty(t, last.SpeedFormatted, "格式化速度字符串必须非空")

			var cacheUpdates []Progress
			cacheCb := func(p Progress) {
				cacheUpdates = append(cacheUpdates, p)
			}
			cacheCtx := WithProgress(context.Background(), cacheCb)
			dir2, fromCache2, err2 := svc.EnsureWithCap(cacheCtx, "owner", "repo", sha, 0, "", 200*1024)
			require.NoError(t, err2)
			assert.True(t, fromCache2)
			assert.Equal(t, dir, dir2)
			require.Len(t, cacheUpdates, 1, "缓存命中时必须触发一次 cached 进度回调")
			assert.Equal(t, 100.0, cacheUpdates[0].Percent)
			assert.Equal(t, "cached", cacheUpdates[0].SpeedFormatted)
		})
	}
}

func TestArchiveEnsure_WithAllowedFiles(t *testing.T) {
	tmpDir := t.TempDir()
	sha := "1111111111111111111111111111111111111111"

	tarData := testTarGz(t, map[string]string{
		"owner-repo-sha/README.md":         "# Main Readme",
		"owner-repo-sha/src/main.py":       "print('hello')",
		"owner-repo-sha/records/bench.txt": strings.Repeat("bench-log-entry\n", 5000),
		"owner-repo-sha/records/huge.txt":  strings.Repeat("massive-trace-data\n", 5000),
	})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-gzip")
		_, _ = w.Write(tarData)
	}))
	defer server.Close()

	svc := NewEnsureService(Config{
		ArchiveRoot:   tmpDir,
		EntryCapBytes: 50 * 1024,
		GitHubAPIBase: server.URL,
	})

	allowed := map[string]bool{
		"src/main.py": true,
	}
	ctx := WithAllowedFiles(context.Background(), allowed)

	dir, fromCache, err := svc.EnsureWithCap(ctx, "owner", "repo", sha, 0, "", 50*1024)
	require.NoError(t, err)
	assert.False(t, fromCache)
	assert.NotEmpty(t, dir)

	assert.FileExists(t, filepath.Join(dir, "README.md"), "根 README 作为全局清单必须保留")
	assert.FileExists(t, filepath.Join(dir, "src", "main.py"), "白名单指定的核心代码文件必须落盘")
	assert.NoFileExists(t, filepath.Join(dir, "records", "bench.txt"), "非白名单的日志文件绝不能落盘")
	assert.NoFileExists(t, filepath.Join(dir, "records", "huge.txt"), "非白名单的日志文件绝不能落盘")
	assert.FileExists(t, filepath.Join(dir, scopedMarkerFile), "局部白名单解压必须打上 scoped 标记")

	dir2, fromCache2, err2 := svc.EnsureWithCap(ctx, "owner", "repo", sha, 0, "", 50*1024)
	require.NoError(t, err2)
	assert.True(t, fromCache2, "相同白名单文件已在磁盘时必须命中缓存")
	assert.Equal(t, dir, dir2)
}
