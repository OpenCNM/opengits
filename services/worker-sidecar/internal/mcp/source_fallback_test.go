package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opengits/worker-sidecar/internal/rsg"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setTestSourceFallbackBase(t *testing.T, base string) {
	t.Helper()
	sourceFallbackMu.Lock()
	prev := sourceFallbackBase
	sourceFallbackBase = base
	sourceFallbackMu.Unlock()
	sourceFallbackCache = newTTLCache(sourceFallbackHitTTL, sourceFallbackCacheLimit)
	t.Cleanup(func() {
		sourceFallbackMu.Lock()
		sourceFallbackBase = prev
		sourceFallbackMu.Unlock()
		sourceFallbackCache = newTTLCache(sourceFallbackHitTTL, sourceFallbackCacheLimit)
	})
}

func TestFetchImmutableSourceFile(t *testing.T) {
	sha := "abcdef1234567890abcdef1234567890abcdef12"

	tests := []struct {
		name     string
		owner    string
		ref      string
		relPath  string
		wantHit  bool
		wantBody string
	}{
		{
			name:     "fetches immutable file and warms local archive",
			owner:    "acme",
			ref:      sha,
			relPath:  "src/app.ts",
			wantHit:  true,
			wantBody: "export const ok = true;\n",
		},
		{
			name:    "skips web-docs virtual owner",
			owner:   "web-docs",
			ref:     sha,
			relPath: "src/app.ts",
			wantHit: false,
		},
		{
			name:    "caches 404 miss cleanly",
			owner:   "acme",
			ref:     sha,
			relPath: "src/missing.ts",
			wantHit: false,
		},
	}

	var reqCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqCount.Add(1)
		if r.URL.Path == "/acme/demo/"+sha+"/src/app.ts" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("export const ok = true;\n"))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			archiveRoot := t.TempDir()
			setTestSourceFallbackBase(t, srv.URL)
			reqCount.Store(0)

			got := fetchImmutableSourceFile(context.Background(), archiveRoot, tt.owner, "demo", tt.ref, tt.relPath)
			if !tt.wantHit {
				assert.Empty(t, got)
				return
			}
			assert.Equal(t, tt.wantBody, got)
			assert.Equal(t, int32(1), reqCount.Load())

			// 本地归档已回暖：readRawSourceFile 直接命中磁盘，不再发起 HTTP 请求
			local := readRawSourceFile(archiveRoot, tt.owner, "demo", tt.ref, tt.relPath)
			assert.Equal(t, tt.wantBody, local)

			// 再次调用走内存 TTL 缓存也不再发起 HTTP 请求
			again := fetchImmutableSourceFile(context.Background(), t.TempDir(), tt.owner, "demo", tt.ref, tt.relPath)
			assert.Equal(t, tt.wantBody, again)
			assert.Equal(t, int32(1), reqCount.Load())
		})
	}
}

type fakeSymbolGraphFakeStore struct {
	*readFakeStore
	graphs map[string]*rsg.SemanticGraphArtifact
}

func (f *fakeSymbolGraphFakeStore) LoadSemanticGraph(_ context.Context, owner, repo, sha string) (*rsg.SemanticGraphArtifact, error) {
	return f.graphs[owner+"/"+repo+"@"+sha], nil
}

func TestLoadSemanticGraphForMCP_WorkerBackfill(t *testing.T) {
	graphDir := t.TempDir()
	sha := "3333333333333333333333333333333333333333"
	baseFake := newReadFakeStore()
	dbStore := &fakeSymbolGraphFakeStore{
		readFakeStore: baseFake,
		graphs:        make(map[string]*rsg.SemanticGraphArtifact),
	}

	var calls atomic.Int32
	workerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		assert.Equal(t, "/v1/graph/symbol-search", r.URL.Path)
		assert.Equal(t, "secret-internal", r.Header.Get("x-internal-token"))
		// 模拟 worker-sidecar 懒构建并将图谱写入数据库
		dbStore.graphs["acme/kit@"+sha] = &rsg.SemanticGraphArtifact{
			Version: 2,
			GitSha:  sha,
			Nodes:   []rsg.SemanticGraphArtifactNode{{Path: "main.go", Role: rsg.RoleEntryPoint, PageRank: 0.9}},
			SymbolsByFile: map[string][]rsg.SymbolEntry{
				"main.go": {{Name: "Bootstrap", Kind: "function", StartLine: 1, EndLine: 12, Exported: true}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "symbols": []any{}})
	}))
	defer workerSrv.Close()

	graphBackfillCache = newTTLCache(5*time.Minute, 256)
	rs := &readService{
		store:            dbStore,
		policyCache:      newTTLCache(60*time.Second, 16),
		workerSidecarURL: workerSrv.URL,
		internalToken:    "secret-internal",
	}

	art := rs.loadSemanticGraphForMCP(context.Background(), graphDir, "acme", "kit", sha, "main")
	require.NotNil(t, art)
	assert.Equal(t, int32(1), calls.Load())
	require.Len(t, art.SymbolsByFile["main.go"], 1)
	assert.Equal(t, "Bootstrap", art.SymbolsByFile["main.go"][0].Name)

	// 验证磁盘缓存已同步回暖
	_, statErr := os.Stat(filepath.Join(graphDir, "acme", "kit", sha+".json"))
	assert.NoError(t, statErr)
}
