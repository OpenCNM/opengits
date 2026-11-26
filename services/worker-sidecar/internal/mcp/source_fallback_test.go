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

			local := readRawSourceFile(archiveRoot, tt.owner, "demo", tt.ref, tt.relPath)
			assert.Equal(t, tt.wantBody, local)

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

	_, statErr := os.Stat(filepath.Join(graphDir, "acme", "kit", sha+".json"))
	assert.NoError(t, statErr)
}

func TestSearchAndReadSymbol_OnDemandFileFallback(t *testing.T) {
	tests := []struct {
		name     string
		relPath  string
		symName  string
		wantText string
	}{
		{
			name:     "extracts TS symbols on demand from un-graphed repo file via immutable remote fallback",
			relPath:  "extensions/openai/client.ts",
			symName:  "createOpenAIClient",
			wantText: "export function createOpenAIClient",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("ARCHIVE_ROOT", t.TempDir())
			graphBackfillCache = newTTLCache(5*time.Minute, 256)

			sha := "5555555555555555555555555555555555555555"
			sourceBody := "export interface OpenAIConfig {\n  apiKey: string;\n}\n\nexport function createOpenAIClient(cfg: OpenAIConfig): string {\n  return cfg.apiKey;\n}\n"
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/octo/kit/"+sha+"/"+tt.relPath {
					_, _ = w.Write([]byte(sourceBody))
					return
				}
				w.WriteHeader(http.StatusNotFound)
			}))
			defer srv.Close()
			setTestSourceFallbackBase(t, srv.URL)

			store := newReadFakeStore()
			seedAuth(t, store)
			store.resolved["octo/kit"].Repository.RepoProfile = []byte(`{"gitSha":"` + sha + `"}`)

			ts := readTestServer(t, store, nil)
			resp, body := callRead(t, ts, "/api/mcp/octo/kit", "search_symbols", `{"file":"`+tt.relPath+`","query":"createOpenAIClient"}`)
			defer resp.Body.Close()
			text, isErr := parseResultText(t, body)
			assert.False(t, isErr)
			assert.Contains(t, text, tt.symName)
			assert.Contains(t, text, tt.relPath)

			resp2, body2 := callRead(t, ts, "/api/mcp/octo/kit", "read_symbol", `{"symbol":"`+tt.symName+`","file":"`+tt.relPath+`","aspect":"contract"}`)
			defer resp2.Body.Close()
			text2, isErr2 := parseResultText(t, body2)
			assert.False(t, isErr2)
			assert.Contains(t, text2, tt.wantText)
		})
	}
}
