package daemon

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	mcpsidecar "github.com/opengits/worker-sidecar/internal/mcp"
	"github.com/opengits/worker-sidecar/internal/sse"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func getFreeAddress(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err, "failed to allocate free port")
	addr := ln.Addr().String()
	require.NoError(t, ln.Close(), "failed to close probe listener")
	return addr
}

type fakeSearchEngine struct {
	called atomic.Int32
	hits   []mcpsidecar.SearchChunkHit
	err    error
}

func (f *fakeSearchEngine) SearchChunks(ctx context.Context, req mcpsidecar.SearchChunksRequest) ([]mcpsidecar.SearchChunkHit, error) {
	f.called.Add(1)
	return f.hits, f.err
}

func TestUnifiedSidecar_DualPortListening(t *testing.T) {
	tests := []struct {
		name string
	}{
		{
			name: "single daemon concurrently serves on dual ports without interference",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mcpAddr := getFreeAddress(t)
			workerAddr := getFreeAddress(t)

			mcpCfg := mcpsidecar.Config{
				Addr:          mcpAddr,
				InternalToken: "test-internal-token",
			}
			mcpServer := mcpsidecar.NewMCPServer(mcpCfg, nil, nil, nil)
			require.NotNil(t, mcpServer)

			workerCfg := Config{
				Addr:          workerAddr,
				InternalToken: "test-internal-token",
			}
			workerSrv := newServer(workerCfg, nil, nil, nil, nil)
			workerHttpServer := &http.Server{
				Addr:    workerAddr,
				Handler: workerSrv.routes(),
			}

			mcpErrCh := make(chan error, 1)
			workerErrCh := make(chan error, 1)

			go func() {
				if err := mcpServer.HttpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
					mcpErrCh <- err
				}
			}()

			go func() {
				if err := workerHttpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
					workerErrCh <- err
				}
			}()

			require.Eventually(t, func() bool {
				resp, err := http.Get("http://" + mcpAddr + "/healthz")
				if err != nil || resp.StatusCode != http.StatusOK {
					return false
				}
				_ = resp.Body.Close()

				resp2, err2 := http.Get("http://" + workerAddr + "/healthz")
				if err2 != nil || resp2.StatusCode != http.StatusOK {
					return false
				}
				_ = resp2.Body.Close()
				return true
			}, 3*time.Second, 50*time.Millisecond, "dual ports did not become ready in time")

			respMCP, err := http.Get("http://" + mcpAddr + "/healthz")
			require.NoError(t, err)
			defer respMCP.Body.Close()
			assert.Equal(t, http.StatusOK, respMCP.StatusCode)
			bodyBytes, err := io.ReadAll(respMCP.Body)
			require.NoError(t, err)
			assert.Contains(t, string(bodyBytes), `"status":"ok"`)

			respWorker, err := http.Get("http://" + workerAddr + "/healthz")
			require.NoError(t, err)
			defer respWorker.Body.Close()
			assert.Equal(t, http.StatusOK, respWorker.StatusCode)

			shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			assert.NoError(t, mcpServer.Shutdown(shutdownCtx))
			assert.NoError(t, workerHttpServer.Shutdown(shutdownCtx))
		})
	}
}

func TestUnifiedSidecar_InProcessSearch(t *testing.T) {
	tests := []struct {
		name            string
		req             mcpsidecar.SearchChunksRequest
		engineHits      []mcpsidecar.SearchChunkHit
		engineErr       error
		expectHitsCount int
		expectInProcess bool
	}{
		{
			name: "direct in-process dispatch returns search hits without HTTP overhead",
			req: mcpsidecar.SearchChunksRequest{
				RepositoryID: "repo-123",
				Query:        "authentication middleware",
				Limit:        5,
			},
			engineHits: []mcpsidecar.SearchChunkHit{
				{
					ChunkID:    "chunk-1",
					DocID:      "doc-1",
					Title:      "Auth Guide",
					Path:       "docs/auth.md",
					Snippet:    "jwt validation...",
					Similarity: 0.95,
				},
			},
			expectHitsCount: 1,
			expectInProcess: true,
		},
		{
			name: "empty search query returns empty hits directly",
			req: mcpsidecar.SearchChunksRequest{
				RepositoryID: "repo-123",
				Query:        "",
			},
			engineHits:      nil,
			expectHitsCount: 0,
			expectInProcess: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fakeEngine := &fakeSearchEngine{
				hits: tt.engineHits,
				err:  tt.engineErr,
			}

			cfg := mcpsidecar.Config{
				WorkerSidecarURL: "http://127.0.0.1:9999",
				InternalToken:    "test-token",
			}
			store := mcpsidecar.NewPgxStoreWithPool(nil, cfg, fakeEngine)
			require.NotNil(t, store)

			hits, err := store.SearchChunks(context.Background(), tt.req)
			if tt.engineErr != nil {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.Len(t, hits, tt.expectHitsCount)
				assert.Equal(t, int32(1), fakeEngine.called.Load(), "searchEngine MUST be called directly in-process")
			}
		})
	}
}

func TestUnifiedSidecar_InProcessProjectionInvalidation(t *testing.T) {
	tests := []struct {
		name          string
		initialRepo   string
		initialOwner  string
		initialID     string
		edition       string
		mutateRepo    string
		mutateOwner   string
		mutateID      string
		expectEvicted bool
	}{
		{
			name:          "matching owner/repo triggers instant in-process pointer eviction",
			initialRepo:   "demo-docs",
			initialOwner:  "opengits",
			initialID:     "repo-uuid-1",
			edition:       "base",
			mutateRepo:    "demo-docs",
			mutateOwner:   "opengits",
			mutateID:      "repo-uuid-1",
			expectEvicted: true,
		},
		{
			name:          "different repo leaves active projection intact",
			initialRepo:   "demo-docs",
			initialOwner:  "opengits",
			initialID:     "repo-uuid-1",
			edition:       "base",
			mutateRepo:    "other-repo",
			mutateOwner:   "opengits",
			mutateID:      "repo-uuid-2",
			expectEvicted: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			projStore := mcpsidecar.NewProjectionStore()
			require.NotNil(t, projStore)

			projStore.Set(&mcpsidecar.RepoStructuralProjection{
				RepoID:           tt.initialID,
				Owner:            tt.initialOwner,
				Repo:             tt.initialRepo,
				Edition:          tt.edition,
				StructuralDigest: "digest-12345",
				OutlineVersion:   1,
				DocCount:         10,
			})

			initialProj, found := projStore.Get(tt.initialOwner, tt.initialRepo, tt.edition)
			require.True(t, found)
			require.NotNil(t, initialProj)

			store := newPgxStoreWithPool(nil)
			store.SetProjectionStore(projStore)
			assert.Equal(t, projStore, store.ProjectionStore())

			if store.projStore != nil {
				store.projStore.Invalidate(tt.mutateOwner, tt.mutateRepo)
				store.projStore.InvalidateByID(tt.mutateID)
			}

			afterProj, afterFound := projStore.Get(tt.initialOwner, tt.initialRepo, tt.edition)
			if tt.expectEvicted {
				assert.False(t, afterFound, "projection should be instantly evicted from memory")
				assert.Nil(t, afterProj)
			} else {
				assert.True(t, afterFound, "unrelated projection should remain untouched")
				assert.NotNil(t, afterProj)
			}
		})
	}
}

func TestUnifiedSidecar_SharedPgxPool(t *testing.T) {
	tests := []struct {
		name string
	}{
		{
			name: "mcp and worker sidecars share identical pool pointer without duplication",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dummyPool := &pgxpool.Pool{}

			workerStore := newPgxStoreWithPool(dummyPool)
			assert.Equal(t, dummyPool, workerStore.pool, "worker store must hold the shared pool")

			projStore := mcpsidecar.NewProjectionStore()
			workerStore.SetProjectionStore(projStore)

			mcpCfg := mcpsidecar.Config{
				Addr:          ":8081",
				InternalToken: "test-token",
			}
			mcpServer := mcpsidecar.NewMCPServer(mcpCfg, dummyPool, workerStore, projStore)
			require.NotNil(t, mcpServer)
		})
	}
}

func TestUnifiedSidecar_GracefulShutdown(t *testing.T) {
	tests := []struct {
		name string
	}{
		{
			name: "graceful shutdown stops both HTTP servers and releases resources",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mcpAddr := getFreeAddress(t)
			workerAddr := getFreeAddress(t)

			mcpCfg := mcpsidecar.Config{Addr: mcpAddr, InternalToken: "tok"}
			mcpServer := mcpsidecar.NewMCPServer(mcpCfg, nil, nil, nil)

			workerCfg := Config{Addr: workerAddr, InternalToken: "tok"}
			workerSrv := newServer(workerCfg, nil, nil, nil, nil)
			workerHttpServer := &http.Server{Addr: workerAddr, Handler: workerSrv.routes()}

			go func() { _ = mcpServer.HttpServer.ListenAndServe() }()
			go func() { _ = workerHttpServer.ListenAndServe() }()

			require.Eventually(t, func() bool {
				r1, e1 := http.Get("http://" + mcpAddr + "/healthz")
				if e1 != nil {
					return false
				}
				_ = r1.Body.Close()

				r2, e2 := http.Get("http://" + workerAddr + "/healthz")
				if e2 != nil {
					return false
				}
				_ = r2.Body.Close()
				return true
			}, 3*time.Second, 50*time.Millisecond)

			shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()

			err1 := mcpServer.Shutdown(shutdownCtx)
			err2 := workerHttpServer.Shutdown(shutdownCtx)

			assert.NoError(t, err1, "mcp server graceful shutdown failed")
			assert.NoError(t, err2, "worker server graceful shutdown failed")

			_, errConn1 := http.Get("http://" + mcpAddr + "/healthz")
			assert.Error(t, errConn1, "mcp port should no longer accept connections")

			_, errConn2 := http.Get("http://" + workerAddr + "/healthz")
			assert.Error(t, errConn2, "worker port should no longer accept connections")
		})
	}
}

func TestUnifiedSidecar_SSERouteMounting(t *testing.T) {
	tests := []struct {
		name         string
		mountSSE     bool
		targetPath   string
		expectStatus int
	}{
		{
			name:         "with sse gateway mounts /api/ingest-jobs/{id}/events (unauth 401)",
			mountSSE:     true,
			targetPath:   "/api/ingest-jobs/job-test/events",
			expectStatus: http.StatusUnauthorized,
		},
		{
			name:         "with sse gateway mounts /v1/sse/ingest-jobs/{id}/events (unauth 401)",
			mountSSE:     true,
			targetPath:   "/v1/sse/ingest-jobs/job-test/events",
			expectStatus: http.StatusUnauthorized,
		},
		{
			name:         "with sse gateway mounts /api/mcp/active-clients/stream (unauth 200 stream frame)",
			mountSSE:     true,
			targetPath:   "/api/mcp/active-clients/stream",
			expectStatus: http.StatusOK,
		},
		{
			name:         "without sse gateway returns 404 for unmounted sse path",
			mountSSE:     false,
			targetPath:   "/v1/sse/ingest-jobs/job-test/events",
			expectStatus: http.StatusNotFound,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Config{
				Addr:          ":0",
				InternalToken: "test-internal-token",
			}
			var gw *sse.Gateway
			if tt.mountSSE {
				gw = sse.NewGateway(cfg.SSEConfig(), nil)
			}
			srv := newServer(cfg, nil, gw, nil, nil)
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, tt.targetPath, nil)
			srv.routes().ServeHTTP(rec, req)

			assert.Equal(t, tt.expectStatus, rec.Code)
		})
	}
}
