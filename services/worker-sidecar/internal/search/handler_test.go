package search

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/ogis"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockSearchStore struct {
	repoHits       []SearchChunkHit
	repoErr        error
	globalHits     []SearchChunkHit
	globalErr      error
	unifiedHits    []UnifiedSearchHit
	unifiedErr     error
	lastRepoReq    SearchChunksRequest
	lastGlobalReq  SearchChunksRequest
	lastUnifiedReq UnifiedSearchRequest
}

func (m *mockSearchStore) SearchRepositoryChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error) {
	m.lastRepoReq = req
	if m.repoErr != nil {
		return nil, m.repoErr
	}
	return m.repoHits, nil
}

func (m *mockSearchStore) SearchGlobalChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error) {
	m.lastGlobalReq = req
	if m.globalErr != nil {
		return nil, m.globalErr
	}
	return m.globalHits, nil
}

func (m *mockSearchStore) SearchUnified(ctx context.Context, req UnifiedSearchRequest) ([]UnifiedSearchHit, error) {
	m.lastUnifiedReq = req
	if m.unifiedErr != nil {
		return nil, m.unifiedErr
	}
	return m.unifiedHits, nil
}

type testSearchServer struct {
	handler *Handler
	routes  http.Handler
}

func newTestRoutes(h *Handler, token string) http.Handler {
	mux := http.NewServeMux()
	auth := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("x-internal-token")), []byte(token)) != 1 {
				httpx.Error(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("POST /v1/search/chunks", auth(h.HandleChunks))
	mux.HandleFunc("POST /v1/search/unified", auth(h.HandleUnified))
	mux.HandleFunc("POST /v1/search/index/build", auth(h.HandleIndexBuild))
	return mux
}

func newTestSearchServer(t *testing.T, store Store, builder *IndexBuilder, assets archive.AssetStore) *testSearchServer {
	t.Helper()
	token := "test-secret-token"
	h := NewHandler(store, builder, nil, assets)
	return &testSearchServer{
		handler: h,
		routes:  newTestRoutes(h, token),
	}
}

func TestSearchHandler_HandleSearchChunks(t *testing.T) {
	tests := []struct {
		name          string
		token         string
		body          string
		store         *mockSearchStore
		wantStatus    int
		wantHitsLen   int
		wantCheckReq  func(t *testing.T, store *mockSearchStore)
		wantCheckResp func(t *testing.T, resp SearchChunksResponse)
	}{
		{
			name:        "unauthorized when token missing",
			token:       "",
			body:        `{"query":"test"}`,
			store:       &mockSearchStore{},
			wantStatus:  http.StatusUnauthorized,
			wantHitsLen: -1,
		},
		{
			name:        "unauthorized when token invalid",
			token:       "wrong-token",
			body:        `{"query":"test"}`,
			store:       &mockSearchStore{},
			wantStatus:  http.StatusUnauthorized,
			wantHitsLen: -1,
		},
		{
			name:        "bad request on invalid json",
			token:       "test-secret-token",
			body:        `{invalid-json`,
			store:       &mockSearchStore{},
			wantStatus:  http.StatusBadRequest,
			wantHitsLen: -1,
		},
		{
			name:        "🧪 [9.5.2.2] empty query returns empty hits immediately without calling store",
			token:       "test-secret-token",
			body:        `{"query":"","rawQuery":""}`,
			store:       &mockSearchStore{},
			wantStatus:  http.StatusOK,
			wantHitsLen: 0,
		},
		{
			name:       "service unavailable when searchStore is nil",
			token:      "test-secret-token",
			body:       `{"query":"hello","repositoryId":"repo-1"}`,
			store:      nil,
			wantStatus: http.StatusServiceUnavailable,
		},
		{
			name:  "🧪 [9.5.1.1] [9.5.2.1] repository search success with bounded chunk metadata and snippet",
			token: "test-secret-token",
			body:  `{"repositoryId":"repo-123","query":"docker","limit":10}`,
			store: &mockSearchStore{
				repoHits: []SearchChunkHit{
					{
						ChunkID:    "chunk-1",
						DocID:      "doc-1",
						Title:      "Docker Guide",
						Path:       "guide.md",
						Snippet:    "Docker container setup",
						Similarity: 0.95,
					},
				},
			},
			wantStatus:  http.StatusOK,
			wantHitsLen: 1,
			wantCheckReq: func(t *testing.T, s *mockSearchStore) {
				t.Helper()
				assert.Equal(t, "repo-123", s.lastRepoReq.RepositoryID)
				assert.Equal(t, "docker", s.lastRepoReq.Query)
				assert.Equal(t, 10, s.lastRepoReq.Limit)
			},
		},
		{
			name:  "🧪 [9.5.1.2] [9.5.2.1] global search success when repositoryId is empty (sql pushdown)",
			token: "test-secret-token",
			body:  `{"query":"kubernetes","limit":5}`,
			store: &mockSearchStore{
				globalHits: []SearchChunkHit{
					{
						ChunkID:    "chunk-g1",
						DocID:      "doc-g1",
						Title:      "K8s Guide",
						Path:       "k8s.md",
						Snippet:    "Kubernetes deployment",
						Similarity: 0.88,
						Owner:      "org",
						Repo:       "project",
					},
				},
			},
			wantStatus:  http.StatusOK,
			wantHitsLen: 1,
			wantCheckReq: func(t *testing.T, s *mockSearchStore) {
				t.Helper()
				assert.Equal(t, "kubernetes", s.lastGlobalReq.Query)
				assert.Equal(t, 5, s.lastGlobalReq.Limit)
			},
		},
		{
			name:  "🧪 [9.5.1.2] user isolation parameter forwarding (ownerUserId constraint)",
			token: "test-secret-token",
			body:  `{"query":"database","userId":"user-alice"}`,
			store: &mockSearchStore{
				globalHits: []SearchChunkHit{},
			},
			wantStatus:  http.StatusOK,
			wantHitsLen: 0,
			wantCheckReq: func(t *testing.T, s *mockSearchStore) {
				t.Helper()
				require.NotNil(t, s.lastGlobalReq.UserID)
				assert.Equal(t, "user-alice", *s.lastGlobalReq.UserID)
			},
		},
		{
			name:  "token budget and snippet max length parameters forwarding",
			token: "test-secret-token",
			body:  `{"query":"cache","repositoryId":"repo-1","tokenBudget":1000,"snippetMaxLen":160}`,
			store: &mockSearchStore{
				repoHits: []SearchChunkHit{},
			},
			wantStatus:  http.StatusOK,
			wantHitsLen: 0,
			wantCheckReq: func(t *testing.T, s *mockSearchStore) {
				t.Helper()
				assert.Equal(t, 1000, s.lastRepoReq.TokenBudget)
				assert.Equal(t, 160, s.lastRepoReq.SnippetMaxLen)
			},
		},
		{
			name:  "response includes full hit metadata when present",
			token: "test-secret-token",
			body:  `{"query":"arch","repositoryId":"repo-1"}`,
			store: func() *mockSearchStore {
				heading := "Architecture"
				hp := "Doc > Architecture"
				ed := "速查手册讲法"
				mc := 4
				rank := 0.82
				return &mockSearchStore{
					repoHits: []SearchChunkHit{
						{
							ChunkID:      "chunk-full",
							DocID:        "doc-full",
							Title:        "System Design",
							Path:         "arch.md",
							Heading:      &heading,
							HeadingPath:  &hp,
							Snippet:      "High level architecture overview",
							Similarity:   0.9,
							EditionLabel: &ed,
							MatchCount:   &mc,
							FtsRank:      &rank,
						},
					},
				}
			}(),
			wantStatus:  http.StatusOK,
			wantHitsLen: 1,
			wantCheckResp: func(t *testing.T, resp SearchChunksResponse) {
				t.Helper()
				require.Len(t, resp.Hits, 1)
				h := resp.Hits[0]
				assert.Equal(t, "chunk-full", h.ChunkID)
				require.NotNil(t, h.Heading)
				assert.Equal(t, "Architecture", *h.Heading)
				require.NotNil(t, h.HeadingPath)
				assert.Equal(t, "Doc > Architecture", *h.HeadingPath)
				require.NotNil(t, h.EditionLabel)
				assert.Equal(t, "速查手册讲法", *h.EditionLabel)
				require.NotNil(t, h.MatchCount)
				assert.Equal(t, 4, *h.MatchCount)
				require.NotNil(t, h.FtsRank)
				assert.InDelta(t, 0.82, *h.FtsRank, 0.001)
			},
		},
		{
			name:  "internal server error on store failure",
			token: "test-secret-token",
			body:  `{"repositoryId":"repo-err","query":"fail"}`,
			store: &mockSearchStore{
				repoErr: errors.New("db connection lost"),
			},
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var srv *testSearchServer
			if tt.store != nil {
				srv = newTestSearchServer(t, tt.store, nil, nil)
			} else {
				srv = newTestSearchServer(t, nil, nil, nil)
			}

			req := httptest.NewRequest(http.MethodPost, "/v1/search/chunks", bytes.NewBufferString(tt.body))
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			rec := httptest.NewRecorder()

			srv.routes.ServeHTTP(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.wantHitsLen >= 0 {
				var resp SearchChunksResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Len(t, resp.Hits, tt.wantHitsLen)
				if tt.wantCheckResp != nil {
					tt.wantCheckResp(t, resp)
				}
			}
			if tt.wantCheckReq != nil && tt.store != nil {
				tt.wantCheckReq(t, tt.store)
			}
		})
	}
}

func TestSearchHandler_HandleSearchIndexBuild(t *testing.T) {
	fakeStore := newFakeSearchIndexStore()
	sha := "commit-123"
	fakeStore.addRepo(OGISRepoMeta{ID: "repo-ok", Owner: "alice", Repo: "proj", GitSha: &sha})
	fakeAssets := newFakeAssetStore()
	builder := NewSearchIndexBuilder(Config{SearchIndexDebounceMs: 50, SearchIndexGzipLevel: 1}, fakeStore, fakeAssets)

	tests := []struct {
		name       string
		token      string
		body       string
		builder    *SearchIndexBuilder
		wantStatus int
		wantOK     bool
		wantBuilt  bool
	}{
		{
			name:       "unauthorized when token missing",
			token:      "",
			body:       `{"repositoryId":"repo-ok"}`,
			builder:    builder,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "unauthorized when token invalid",
			token:      "wrong-token",
			body:       `{"repositoryId":"repo-ok"}`,
			builder:    builder,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "bad request on invalid json",
			token:      "test-secret-token",
			body:       `{broken-json`,
			builder:    builder,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "bad request on empty repositoryId",
			token:      "test-secret-token",
			body:       `{"repositoryId":"   "}`,
			builder:    builder,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "service unavailable when indexBuilder is nil",
			token:      "test-secret-token",
			body:       `{"repositoryId":"repo-ok"}`,
			builder:    nil,
			wantStatus: http.StatusServiceUnavailable,
		},
		{
			name:       "internal server error when BuildRepo fails",
			token:      "test-secret-token",
			body:       `{"repositoryId":"non-existent-repo"}`,
			builder:    builder,
			wantStatus: http.StatusInternalServerError,
		},
		{
			name:       "success when BuildRepo succeeds",
			token:      "test-secret-token",
			body:       `{"repositoryId":"repo-ok"}`,
			builder:    builder,
			wantStatus: http.StatusOK,
			wantOK:     true,
			wantBuilt:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestSearchServer(t, nil, tt.builder, fakeAssets)

			req := httptest.NewRequest(http.MethodPost, "/v1/search/index/build", bytes.NewBufferString(tt.body))
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			rec := httptest.NewRecorder()

			srv.routes.ServeHTTP(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.wantStatus == http.StatusOK {
				var resp SearchIndexBuildResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Equal(t, tt.wantOK, resp.OK)
				assert.Equal(t, tt.wantBuilt, resp.Built)
			}
		})
	}
}

func TestSearchHelper_BuildTsQuery(t *testing.T) {
	tests := []struct {
		name  string
		query string
		want  string
	}{
		{
			name:  "empty query",
			query: "",
			want:  "",
		},
		{
			name:  "pure whitespace and underscores",
			query: "   __  _   ",
			want:  "",
		},
		{
			name:  "single term",
			query: "docker",
			want:  "docker:*",
		},
		{
			name:  "multiple terms with special characters stripped",
			query: "docker & k8s | (deploy!)",
			want:  "docker:* & k8s:* & deploy:*",
		},
		{
			name:  "chinese characters",
			query: "分布式 事务架构",
			want:  "分布式:* & 事务架构:*",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildTsQuery(tt.query)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestSearchHelper_GetFtsLanguageConfig(t *testing.T) {
	tests := []struct {
		name   string
		locale string
		want   string
	}{
		{name: "empty locale defaults to simple", locale: "", want: "simple"},
		{name: "english locked to simple (index column is simple)", locale: "en", want: "simple"},
		{name: "english with country locked to simple", locale: "en-US", want: "simple"},
		{name: "chinese locale", locale: "zh-CN", want: "simple"},
		{name: "japanese locale", locale: "ja", want: "simple"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := getFtsLanguageConfig(tt.locale)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestSearchHelper_ExtractSearchTokens(t *testing.T) {
	tests := []struct {
		name  string
		query string
		want  []string
	}{
		{
			name:  "short tokens filtered out",
			query: "a b c",
			want:  nil,
		},
		{
			name:  "alphanumeric tokens",
			query: "docker compose v2",
			want:  []string{"docker", "compose", "v2"},
		},
		{
			name:  "cjk tokens",
			query: "构建 nextjs 极速服务",
			want:  []string{"构建", "nextjs", "极速服务"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractSearchTokens(tt.query)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestOGISIndexCache_LRUEvictionAndRepoInvalidation(t *testing.T) {

	lruCache := newOGISIndexCache(2)
	idxDummy := &ogis.Index{Owner: "dummy"}
	lruCache.Set("repo-1", idxDummy)
	time.Sleep(10 * time.Millisecond)
	lruCache.Set("repo-2", idxDummy)
	time.Sleep(10 * time.Millisecond)

	_, ok := lruCache.Get("repo-1")
	assert.True(t, ok)
	time.Sleep(10 * time.Millisecond)

	lruCache.Set("repo-3", idxDummy)

	_, ok1 := lruCache.Get("repo-1")
	assert.True(t, ok1, "repo-1 最近被访问，不应被淘汰")
	_, ok2 := lruCache.Get("repo-2")
	assert.False(t, ok2, "repo-2 最久未访问，应被 LRU 淘汰")
	_, ok3 := lruCache.Get("repo-3")
	assert.True(t, ok3, "repo-3 新插入，应存在")

	h := NewHandler(nil, nil, nil, nil)
	h.cache.Set("facebook/react/sha-x", idxDummy)
	h.InvalidateRepoCache("facebook", "react")
	_, ok4 := h.cache.Get("facebook/react/sha-x")
	assert.False(t, ok4, "InvalidateRepoCache 后同 repo 缓存应落空")
}
