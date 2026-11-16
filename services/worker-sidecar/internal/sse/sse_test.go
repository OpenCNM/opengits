package sse

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeSSEStore 单测桩，用于完全离线测试 SSE 网关契约
type fakeSSEStore struct {
	mu           sync.Mutex
	mcpTokens    map[string]string // tokenHash -> userId
	jobs         map[string]*ImportJobSnapshot
	jobEvents    map[string][]ImportJobEventDTO
	queuePos     int
	hasTermEvent map[string]bool
	notifSnaps   map[string]*NotificationSnapshot
	repos        map[string]*RepositorySnapshot
	repoAccess   map[string]bool
	repoIngest   map[string]string
	activeClis   map[string][]ProjectedClient
}

var _ Store = (*fakeSSEStore)(nil)
var _ SSEStore = (*fakeSSEStore)(nil)

// newFakeSSEStore 统一单测桩夹具，声明 t.Helper()
func newFakeSSEStore(t ...*testing.T) *fakeSSEStore {
	if len(t) > 0 && t[0] != nil {
		t[0].Helper()
	}
	return &fakeSSEStore{
		mcpTokens:    make(map[string]string),
		jobs:         make(map[string]*ImportJobSnapshot),
		jobEvents:    make(map[string][]ImportJobEventDTO),
		hasTermEvent: make(map[string]bool),
		notifSnaps:   make(map[string]*NotificationSnapshot),
		repos:        make(map[string]*RepositorySnapshot),
		repoAccess:   make(map[string]bool),
		repoIngest:   make(map[string]string),
		activeClis:   make(map[string][]ProjectedClient),
	}
}

func (f *fakeSSEStore) GetUserIdByMcpToken(_ context.Context, tokenHash string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.mcpTokens[tokenHash], nil
}

func (f *fakeSSEStore) GetImportJobSnapshot(_ context.Context, jobId string) (*ImportJobSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.jobs[jobId], nil
}

func (f *fakeSSEStore) GetImportJobEvents(_ context.Context, jobId string, sinceSeq int) ([]ImportJobEventDTO, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var res []ImportJobEventDTO
	for _, ev := range f.jobEvents[jobId] {
		if ev.Seq > sinceSeq {
			res = append(res, ev)
		}
	}
	return res, nil
}

func (f *fakeSSEStore) GetQueuedJobPosition(_ context.Context, _ time.Time) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.queuePos, nil
}

func (f *fakeSSEStore) ListQueuedJobCreatedAts(_ context.Context) ([]time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var createds []time.Time
	for _, j := range f.jobs {
		if j.Status == "QUEUED" {
			createds = append(createds, j.CreatedAt)
		}
	}
	sort.Slice(createds, func(i, j int) bool { return createds[i].Before(createds[j]) })
	return createds, nil
}

func (f *fakeSSEStore) HasTerminalEvent(_ context.Context, jobId string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hasTermEvent[jobId], nil
}

func (f *fakeSSEStore) GetNotificationSnapshot(_ context.Context, userId string) (*NotificationSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.notifSnaps[userId], nil
}

func (f *fakeSSEStore) GetRepositoryForEvents(_ context.Context, owner, repo, branch, edition string) (*RepositorySnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := fmt.Sprintf("%s/%s/%s/%s", owner, repo, branch, edition)
	return f.repos[key], nil
}

func (f *fakeSSEStore) VerifyRepoAccess(_ context.Context, repositoryId string, isPublic bool, userId string) (bool, error) {
	if isPublic {
		return true, nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.repoAccess[repositoryId+":"+userId], nil
}

func (f *fakeSSEStore) GetRepoIngestSnapshot(_ context.Context, repositoryId string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.repoIngest[repositoryId], nil
}

func (f *fakeSSEStore) GetActiveClients(_ context.Context, userId string, _ time.Time) ([]ProjectedClient, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.activeClis[userId], nil
}

// nonFlusherResponseWriter 辅助桩：不实现 http.Flusher
type nonFlusherResponseWriter struct {
	header http.Header
}

func (n *nonFlusherResponseWriter) Header() http.Header {
	if n.header == nil {
		n.header = make(http.Header)
	}
	return n.header
}

func (n *nonFlusherResponseWriter) Write(b []byte) (int, error) {
	return len(b), nil
}

func (n *nonFlusherResponseWriter) WriteHeader(statusCode int) {}

// ── 1. SSEWriter 格式、协议与防御边界测试 ──────────────────────
func TestSSEWriterFormatting(t *testing.T) {
	tests := []struct {
		name    string
		execute func(t *testing.T)
	}{
		{
			name: "standard formatting with retry, comment, json, and multiline events",
			execute: func(t *testing.T) {
				rec := httptest.NewRecorder()
				sw, err := NewWriter(rec)
				require.NoError(t, err)

				require.NoError(t, sw.SendRetry(3000))
				require.NoError(t, sw.SendComment("ping"))
				require.NoError(t, sw.SendEvent("1", "notifications", map[string]int{"unreadCount": 5}))
				require.NoError(t, sw.SendEvent("2", "log", "line1\nline2"))
				require.NoError(t, sw.SendEvent("3", "raw", []byte(`{"raw":true}`)))
				require.NoError(t, sw.SendEvent("", "", ""))

				output := rec.Body.String()
				assert.Contains(t, output, "retry: 3000\n\n")
				assert.Contains(t, output, ": ping\n\n")
				assert.Contains(t, output, "id: 1\nevent: notifications\ndata: {\"unreadCount\":5}\n\n")
				assert.Contains(t, output, "id: 2\nevent: log\ndata: line1\ndata: line2\n\n")
				assert.Contains(t, output, "id: 3\nevent: raw\ndata: {\"raw\":true}\n\n")
				assert.Contains(t, output, "data: \n\n")
				assert.Contains(t, rec.Header().Get("Content-Type"), "text/event-stream")
				assert.Equal(t, "no", rec.Header().Get("X-Accel-Buffering"))
				assert.Equal(t, "keep-alive", rec.Header().Get("Connection"))
			},
		},
		{
			name: "rejects non-flusher ResponseWriter",
			execute: func(t *testing.T) {
				_, err := NewWriter(&nonFlusherResponseWriter{})
				assert.Error(t, err)
				assert.Contains(t, err.Error(), "http.Flusher")
			},
		},
		{
			name: "rejects writes after close",
			execute: func(t *testing.T) {
				rec := httptest.NewRecorder()
				sw, err := NewWriter(rec)
				require.NoError(t, err)

				sw.Close()
				assert.Error(t, sw.SendRetry(1000))
				assert.Error(t, sw.SendComment("ping"))
				assert.Error(t, sw.SendEvent("1", "test", "data"))
			},
		},
		{
			name: "fails on unmarshalable data type",
			execute: func(t *testing.T) {
				rec := httptest.NewRecorder()
				sw, err := NewWriter(rec)
				require.NoError(t, err)

				err = sw.SendEvent("1", "test", make(chan int))
				assert.Error(t, err)
				assert.Contains(t, err.Error(), "json marshal error")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, tt.execute)
	}
}

// ── 2. AuthResolver 多源鉴权测试 ─────────────────────────────
func TestSSEAuthResolver(t *testing.T) {
	cfg := Config{InternalToken: "secret-internal", LlmGatewayURL: "http://localhost:3000"}
	store := newFakeSSEStore(t)
	cache := NewSessionAuthCache()
	resolver := NewAuthResolver(cfg, store, cache)

	sessionVal := "cookie_session_xyz"
	sessionCookieStr := "next-auth.session-token=" + sessionVal
	sessionHash := sha256Hex(sessionCookieStr)
	cache.Set(sessionHash, "user-cookie-real", 5*time.Minute)

	token := "mcp_token_abc"
	tokenHash := sha256Hex(token)
	store.mcpTokens[tokenHash] = "user-mcp-456"

	tests := []struct {
		name     string
		buildReq func() *http.Request
		wantUid  string
		wantAuth bool
		wantErr  bool
	}{
		{
			name: "internal privileged with x-user-id",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/test", nil)
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("x-user-id", "user-123")
				return req
			},
			wantUid:  "user-123",
			wantAuth: true,
			wantErr:  false,
		},
		{
			name: "internal privileged with cookie resolves real cookie identity",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/test", nil)
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("Cookie", sessionCookieStr)
				return req
			},
			wantUid:  "user-cookie-real",
			wantAuth: true,
			wantErr:  false,
		},
		{
			name: "internal privileged without x-user-id or cookie falls back to internal",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/test", nil)
				req.Header.Set("x-internal-token", "secret-internal")
				return req
			},
			wantUid:  "internal",
			wantAuth: true,
			wantErr:  false,
		},
		{
			name: "mcp bearer token auth",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/test", nil)
				req.Header.Set("Authorization", "Bearer "+token)
				return req
			},
			wantUid:  "user-mcp-456",
			wantAuth: true,
			wantErr:  false,
		},
		{
			name: "mcp query parameter token auth",
			buildReq: func() *http.Request {
				return httptest.NewRequest("GET", "/api/test?token="+token, nil)
			},
			wantUid:  "user-mcp-456",
			wantAuth: true,
			wantErr:  false,
		},
		{
			name: "invalid mcp token returns unauthenticated",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/test", nil)
				req.Header.Set("Authorization", "Bearer invalid-token-xyz")
				return req
			},
			wantUid:  "",
			wantAuth: false,
			wantErr:  false,
		},
		{
			name: "invalid internal token rejected",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/test", nil)
				req.Header.Set("x-internal-token", "wrong-secret-token")
				return req
			},
			wantUid:  "",
			wantAuth: false,
			wantErr:  false,
		},
		{
			name: "session cookie cache hit",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/test", nil)
				req.Header.Set("Cookie", sessionCookieStr)
				return req
			},
			wantUid:  "user-cookie-real",
			wantAuth: true,
			wantErr:  false,
		},
		{
			name: "unauthenticated anonymous request",
			buildReq: func() *http.Request {
				return httptest.NewRequest("GET", "/api/test", nil)
			},
			wantUid:  "",
			wantAuth: false,
			wantErr:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := tt.buildReq()
			uid, auth, err := resolver.ResolveAuth(context.Background(), req)
			if tt.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
			assert.Equal(t, tt.wantAuth, auth)
			assert.Equal(t, tt.wantUid, uid)
		})
	}
}

// ── 3. Ingest Jobs SSE 测试（鉴权、游标续传、排队位、终态合成）──────
func TestSSEIngestJobs(t *testing.T) {
	cfg := Config{
		InternalToken:  "secret-internal",
		SseHeartbeatMs: 100,
	}
	store := newFakeSSEStore(t)
	gw := NewGateway(cfg, store)

	jobId := "job-completed"
	store.jobs[jobId] = &ImportJobSnapshot{
		ID:        jobId,
		UserID:    "user-1",
		Status:    "COMPLETED",
		CreatedAt: time.Now().Add(-1 * time.Minute),
	}
	store.jobEvents[jobId] = []ImportJobEventDTO{
		{Seq: 1, Type: "log", Payload: json.RawMessage(`{"message":"Cloning repo"}`)},
		{Seq: 2, Type: "log", Payload: json.RawMessage(`{"message":"Extracting AST"}`)},
		{Seq: 3, Type: "done", Payload: json.RawMessage(`{"message":"Ingestion complete"}`)},
	}
	store.hasTermEvent[jobId] = true

	failedJobId := "job-failed"
	errMsg := "git clone timeout: fatal error"
	store.jobs[failedJobId] = &ImportJobSnapshot{
		ID:        failedJobId,
		UserID:    "user-1",
		Status:    "FAILED",
		Error:     &errMsg,
		CreatedAt: time.Now().Add(-1 * time.Minute),
	}
	store.hasTermEvent[failedJobId] = false

	completedNoTermId := "job-comp-no-term"
	store.jobs[completedNoTermId] = &ImportJobSnapshot{
		ID:        completedNoTermId,
		UserID:    "user-1",
		Status:    "COMPLETED",
		CreatedAt: time.Now().Add(-1 * time.Minute),
	}
	store.hasTermEvent[completedNoTermId] = false

	tests := []struct {
		name       string
		buildReq   func() *http.Request
		wantStatus int
		verifyBody func(t *testing.T, body string)
	}{
		{
			name: "missing job id returns 400",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/ingest-jobs//events", nil)
				req.SetPathValue("id", "")
				return req
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "unauthenticated request returns 401",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/ingest-jobs/"+jobId+"/events", nil)
				req.SetPathValue("id", jobId)
				return req
			},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name: "wrong user ownership returns 404",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/ingest-jobs/"+jobId+"/events", nil)
				req.SetPathValue("id", jobId)
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("x-user-id", "attacker-user")
				return req
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name: "normal consumption with Last-Event-ID replay and merged type",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/ingest-jobs/"+jobId+"/events", nil)
				req.SetPathValue("id", jobId)
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("x-user-id", "user-1")
				req.Header.Set("last-event-id", "1")
				return req
			},
			wantStatus: http.StatusOK,
			verifyBody: func(t *testing.T, body string) {
				assert.Contains(t, body, "retry: 3000\n\n")
				assert.NotContains(t, body, "id: 1\n")
				assert.Contains(t, body, "id: 2\ndata: {\"message\":\"Extracting AST\",\"type\":\"log\"}\n\n")
				assert.Contains(t, body, "id: 3\ndata: {\"message\":\"Ingestion complete\",\"type\":\"done\"}\n\n")
			},
		},
		{
			name: "failed job synthesizes terminal error event when absent from event log",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/ingest-jobs/"+failedJobId+"/events", nil)
				req.SetPathValue("id", failedJobId)
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("x-user-id", "user-1")
				return req
			},
			wantStatus: http.StatusOK,
			verifyBody: func(t *testing.T, body string) {
				assert.Contains(t, body, "retry: 3000\n\n")
				assert.Contains(t, body, "\"type\":\"error\"")
				assert.Contains(t, body, errMsg)
			},
		},
		{
			name: "completed job synthesizes terminal done event when absent from event log",
			buildReq: func() *http.Request {
				req := httptest.NewRequest("GET", "/api/ingest-jobs/"+completedNoTermId+"/events", nil)
				req.SetPathValue("id", completedNoTermId)
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("x-user-id", "user-1")
				return req
			},
			wantStatus: http.StatusOK,
			verifyBody: func(t *testing.T, body string) {
				assert.Contains(t, body, "\"type\":\"done\"")
				assert.Contains(t, body, "Ingestion complete")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := tt.buildReq()
			gw.HandleIngestJobEvents(rec, req)
			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.verifyBody != nil {
				tt.verifyBody(t, rec.Body.String())
			}
		})
	}
}

// ── 4. MCP Active Clients Stream 测试 ────────────────────────
func TestSSEMcpActiveClients(t *testing.T) {
	cfg := Config{InternalToken: "secret-internal"}
	store := newFakeSSEStore(t)
	gw := NewGateway(cfg, store)

	tests := []struct {
		name       string
		setupStore func()
		buildReq   func() (*http.Request, func())
		verify     func(t *testing.T, rec *httptest.ResponseRecorder)
	}{
		{
			name:       "unauthenticated client returns unauthenticated frame",
			setupStore: func() {},
			buildReq: func() (*http.Request, func()) {
				req := httptest.NewRequest("GET", "/api/mcp/active-clients/stream", nil)
				return req, func() {}
			},
			verify: func(t *testing.T, rec *httptest.ResponseRecorder) {
				assert.Contains(t, rec.Body.String(), "data: {\"clients\":[],\"unauthenticated\":true}\n\n")
			},
		},
		{
			name: "authenticated user with no clients streams empty array",
			setupStore: func() {
				store.activeClis["user-empty"] = []ProjectedClient{}
			},
			buildReq: func() (*http.Request, func()) {
				ctx, cancel := context.WithCancel(context.Background())
				req := httptest.NewRequest("GET", "/api/mcp/active-clients/stream", nil).WithContext(ctx)
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("x-user-id", "user-empty")
				go func() {
					time.Sleep(30 * time.Millisecond)
					cancel()
				}()
				return req, cancel
			},
			verify: func(t *testing.T, rec *httptest.ResponseRecorder) {
				assert.Contains(t, rec.Body.String(), "retry: 3000")
				assert.Contains(t, rec.Body.String(), `data: {"clients":[]}`)
			},
		},
		{
			name: "authenticated user streams active clients list with online status",
			setupStore: func() {
				store.activeClis["user-1"] = []ProjectedClient{
					{
						ID:         "cli-1",
						Name:       "Cursor",
						Status:     "online",
						TotalCalls: 10,
						HitCalls:   8,
					},
				}
			},
			buildReq: func() (*http.Request, func()) {
				ctx, cancel := context.WithCancel(context.Background())
				req := httptest.NewRequest("GET", "/api/mcp/active-clients/stream", nil).WithContext(ctx)
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("x-user-id", "user-1")
				go func() {
					time.Sleep(30 * time.Millisecond)
					cancel()
				}()
				return req, cancel
			},
			verify: func(t *testing.T, rec *httptest.ResponseRecorder) {
				assert.Contains(t, rec.Body.String(), `"name":"Cursor"`)
				assert.Contains(t, rec.Body.String(), `"status":"online"`)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.setupStore()
			rec := httptest.NewRecorder()
			req, cleanup := tt.buildReq()
			defer cleanup()

			gw.HandleMcpActiveClients(rec, req)
			tt.verify(t, rec)
		})
	}
}

// ── 5. User Notifications Stream 测试 ────────────────────────
func TestSSENotifications(t *testing.T) {
	cfg := Config{
		InternalToken:      "secret-internal",
		SseProbeIntervalMs: 50,
		SseMaxLifetimeMs:   200,
	}
	store := newFakeSSEStore(t)
	gw := NewGateway(cfg, store)

	latestId := "notif-99"
	store.notifSnaps["user-1"] = &NotificationSnapshot{
		UnreadCount: 3,
		LatestID:    &latestId,
	}

	tests := []struct {
		name       string
		buildReq   func(ctx context.Context) *http.Request
		wantStatus int
		wantBody   string
	}{
		{
			name: "unauthenticated request returns 401",
			buildReq: func(ctx context.Context) *http.Request {
				return httptest.NewRequest("GET", "/api/notifications/stream", nil).WithContext(ctx)
			},
			wantStatus: http.StatusUnauthorized,
			wantBody:   "Unauthorized",
		},
		{
			name: "authenticated user receives notification stream snapshot",
			buildReq: func(ctx context.Context) *http.Request {
				req := httptest.NewRequest("GET", "/api/notifications/stream", nil).WithContext(ctx)
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("x-user-id", "user-1")
				return req
			},
			wantStatus: http.StatusOK,
			wantBody:   "event: notifications\ndata: {\"unreadCount\":3,\"latestId\":\"notif-99\"}\n\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			req := tt.buildReq(ctx)
			gw.HandleNotifications(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			assert.Contains(t, rec.Body.String(), tt.wantBody)
		})
	}
}

// ── 6. Repo Ingest Stream 权限与差分测试 ──────────────────────
func TestSSERepoIngestEvents(t *testing.T) {
	cfg := Config{
		InternalToken:      "secret-internal",
		SseProbeIntervalMs: 50,
		SseMaxLifetimeMs:   200,
	}
	store := newFakeSSEStore(t)
	gw := NewGateway(cfg, store)

	pubRepoKey := "pmndrs/zustand/main/"
	store.repos[pubRepoKey] = &RepositorySnapshot{ID: "repo-zustand", IsPublic: true}
	store.repoIngest["repo-zustand"] = `[{"id":"doc-1","status":"PROCESSED","saved":1,"total":1}]`

	privRepoKey := "private-org/secret/main/"
	store.repos[privRepoKey] = &RepositorySnapshot{ID: "repo-secret", IsPublic: false}
	store.repoAccess["repo-secret:authorized-user"] = true
	store.repoIngest["repo-secret"] = `[{"id":"doc-secret","status":"PROCESSED","saved":5,"total":5}]`

	masterEditionKey := "karpathy/micrograd/master/ed_f8ff03db"
	store.repos[masterEditionKey] = &RepositorySnapshot{ID: "repo-micrograd-ed", IsPublic: true}
	store.repoIngest["repo-micrograd-ed"] = `[{"id":"doc-mg","status":"PROCESSED","saved":1,"total":1}]`

	tests := []struct {
		name       string
		buildReq   func(ctx context.Context) *http.Request
		wantStatus int
		wantBody   string
	}{
		{
			name: "missing repo path returns 400",
			buildReq: func(ctx context.Context) *http.Request {
				req := httptest.NewRequest("GET", "/api/ingest/pmndrs//events", nil).WithContext(ctx)
				req.SetPathValue("owner", "pmndrs")
				req.SetPathValue("repo", "")
				return req
			},
			wantStatus: http.StatusBadRequest,
			wantBody:   "Bad Request: Missing repo path",
		},
		{
			name: "non-existent repo returns 404",
			buildReq: func(ctx context.Context) *http.Request {
				req := httptest.NewRequest("GET", "/api/ingest/pmndrs/unknown/events", nil).WithContext(ctx)
				req.SetPathValue("owner", "pmndrs")
				req.SetPathValue("repo", "unknown")
				return req
			},
			wantStatus: http.StatusNotFound,
			wantBody:   "Repository not found",
		},
		{
			name: "private repo without access returns 403 forbidden",
			buildReq: func(ctx context.Context) *http.Request {
				req := httptest.NewRequest("GET", "/api/ingest/private-org/secret/events", nil).WithContext(ctx)
				req.SetPathValue("owner", "private-org")
				req.SetPathValue("repo", "secret")
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("x-user-id", "unauthorized-user")
				return req
			},
			wantStatus: http.StatusForbidden,
			wantBody:   "Forbidden",
		},
		{
			name: "private repo with valid access streams ingest snapshot",
			buildReq: func(ctx context.Context) *http.Request {
				req := httptest.NewRequest("GET", "/api/ingest/private-org/secret/events", nil).WithContext(ctx)
				req.SetPathValue("owner", "private-org")
				req.SetPathValue("repo", "secret")
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("x-user-id", "authorized-user")
				return req
			},
			wantStatus: http.StatusOK,
			wantBody:   "event: ingest\ndata: [{\"id\":\"doc-secret\",\"status\":\"PROCESSED\",\"saved\":5,\"total\":5}]\n\n",
		},
		{
			name: "valid public repo streams ingest snapshot",
			buildReq: func(ctx context.Context) *http.Request {
				req := httptest.NewRequest("GET", "/api/ingest/pmndrs/zustand/events", nil).WithContext(ctx)
				req.SetPathValue("owner", "pmndrs")
				req.SetPathValue("repo", "zustand")
				return req
			},
			wantStatus: http.StatusOK,
			wantBody:   "event: ingest\ndata: [{\"id\":\"doc-1\",\"status\":\"PROCESSED\",\"saved\":1,\"total\":1}]\n\n",
		},
		{
			name: "explicit branch and edition query params resolve target repository",
			buildReq: func(ctx context.Context) *http.Request {
				req := httptest.NewRequest("GET", "/api/ingest/karpathy/micrograd/events?branch=master&edition=ed_f8ff03db", nil).WithContext(ctx)
				req.SetPathValue("owner", "karpathy")
				req.SetPathValue("repo", "micrograd")
				return req
			},
			wantStatus: http.StatusOK,
			wantBody:   "event: ingest\ndata: [{\"id\":\"doc-mg\",\"status\":\"PROCESSED\",\"saved\":1,\"total\":1}]\n\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			req := tt.buildReq(ctx)
			gw.HandleRepoIngestEvents(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			assert.Contains(t, rec.Body.String(), tt.wantBody)
		})
	}
}

// ── 7. JobSnapshotHub 多观众单轮询总线测试 ──────────────────────
func TestJobSnapshotHubFanout(t *testing.T) {
	tests := []struct {
		name    string
		execute func(t *testing.T)
	}{
		{
			name: "multiple concurrent subscribers receive job snapshots from single poller",
			execute: func(t *testing.T) {
				store := newFakeSSEStore(t)
				jobId := "job-fanout"
				store.jobs[jobId] = &ImportJobSnapshot{
					ID:     jobId,
					UserID: "user-1",
					Status: "RUNNING",
				}

				hub := NewJobSnapshotHub(store)

				sub1 := hub.Subscribe(jobId)
				sub2 := hub.Subscribe(jobId)

				select {
				case b1 := <-sub1.C:
					require.NotNil(t, b1)
					require.NotNil(t, b1.Job)
					assert.Equal(t, jobId, b1.Job.ID)
				case <-time.After(2 * time.Second):
					require.FailNow(t, "sub1 timeout waiting for bundle")
				}

				select {
				case b2 := <-sub2.C:
					require.NotNil(t, b2)
					require.NotNil(t, b2.Job)
					assert.Equal(t, jobId, b2.Job.ID)
				case <-time.After(2 * time.Second):
					require.FailNow(t, "sub2 timeout waiting for bundle")
				}

				sub1.cancel()
				sub2.cancel()

				time.Sleep(100 * time.Millisecond)
				hub.mu.Lock()
				pollerCount := len(hub.jobs)
				hub.mu.Unlock()

				assert.Equal(t, 0, pollerCount, "Expected 0 active pollers after all unsubscribed")
			},
		},
		{
			name: "terminal job status cleans up poller entry from hub",
			execute: func(t *testing.T) {
				store := newFakeSSEStore(t)
				termJobId := "job-term-cleanup"
				store.jobs[termJobId] = &ImportJobSnapshot{
					ID:     termJobId,
					UserID: "user-1",
					Status: "COMPLETED",
				}
				// WP-J：终态宽限等待真实 done 事件行（runner deferred flush 后落库）
				store.jobEvents[termJobId] = []ImportJobEventDTO{{Seq: 1, Type: "done"}}

				hub := NewJobSnapshotHub(store)
				sub := hub.Subscribe(termJobId)
				defer sub.cancel()

				select {
				case b := <-sub.C:
					require.NotNil(t, b)
					assert.Equal(t, "COMPLETED", b.Job.Status)
				case <-time.After(2 * time.Second):
					require.FailNow(t, "timeout waiting for bundle")
				}

				// 等待 poller 终态退出（真实 done 事件抵达后立即清理，不再固定 500ms 抢跑）
				assert.Eventually(t, func() bool {
					hub.mu.Lock()
					defer hub.mu.Unlock()
					return len(hub.jobs) == 0
				}, 3*time.Second, 50*time.Millisecond, "Poller must be evicted from hub on terminal status")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, tt.execute)
	}
}

// ── 8. SessionAuthCache TTL 与失效测试 ──────────────────────────
func TestSessionAuthCache(t *testing.T) {
	tests := []struct {
		name    string
		execute func(t *testing.T)
	}{
		{
			name: "cache set and get before ttl returns stored user id",
			execute: func(t *testing.T) {
				c := NewSessionAuthCache()
				defer c.Close()
				c.Set("hash-valid", "user-42", 500*time.Millisecond)

				uid, ok := c.Get("hash-valid")
				assert.True(t, ok)
				assert.Equal(t, "user-42", uid)
			},
		},
		{
			name: "cache get after ttl expiry returns not found",
			execute: func(t *testing.T) {
				c := NewSessionAuthCache()
				defer c.Close()
				c.Set("hash-expired", "user-old", 50*time.Millisecond)

				time.Sleep(60 * time.Millisecond)
				uid, ok := c.Get("hash-expired")
				assert.False(t, ok)
				assert.Equal(t, "", uid)
			},
		},
		{
			name: "cache get non-existent key returns not found",
			execute: func(t *testing.T) {
				c := NewSessionAuthCache()
				defer c.Close()
				uid, ok := c.Get("hash-not-exists")
				assert.False(t, ok)
				assert.Equal(t, "", uid)
			},
		},
		{
			name: "cache close is idempotent and releases resources",
			execute: func(t *testing.T) {
				c := NewSessionAuthCache()
				assert.NotNil(t, c)
				c.Close()
				assert.NotPanics(t, func() {
					c.Close()
				})
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, tt.execute)
	}
}

// ── 9. ExtractClientIP 测试 ──────────────────────────────────
func TestExtractClientIP(t *testing.T) {
	tests := []struct {
		name       string
		reqBuilder func() *http.Request
		wantIP     string
	}{
		{
			name: "nil request returns unknown",
			reqBuilder: func() *http.Request {
				return nil
			},
			wantIP: "unknown",
		},
		{
			name: "CF-Connecting-IP takes highest precedence",
			reqBuilder: func() *http.Request {
				r := httptest.NewRequest("GET", "/", nil)
				r.Header.Set("CF-Connecting-IP", "104.26.12.34")
				r.Header.Set("X-Real-IP", "10.0.0.1")
				r.Header.Set("X-Forwarded-For", "192.168.1.1")
				r.RemoteAddr = "127.0.0.1:12345"
				return r
			},
			wantIP: "104.26.12.34",
		},
		{
			name: "X-Real-IP takes precedence when CF header absent",
			reqBuilder: func() *http.Request {
				r := httptest.NewRequest("GET", "/", nil)
				r.Header.Set("X-Real-IP", "198.51.100.5")
				r.Header.Set("X-Forwarded-For", "192.168.1.1, 10.0.0.1")
				r.RemoteAddr = "127.0.0.1:12345"
				return r
			},
			wantIP: "198.51.100.5",
		},
		{
			name: "X-Forwarded-For takes first valid IP",
			reqBuilder: func() *http.Request {
				r := httptest.NewRequest("GET", "/", nil)
				r.Header.Set("X-Forwarded-For", "203.0.113.195, 70.41.3.18, 150.172.238.178")
				r.RemoteAddr = "127.0.0.1:12345"
				return r
			},
			wantIP: "203.0.113.195",
		},
		{
			name: "IPv6 with port in RemoteAddr correctly stripped",
			reqBuilder: func() *http.Request {
				r := httptest.NewRequest("GET", "/", nil)
				r.RemoteAddr = "[2001:db8::1]:8080"
				return r
			},
			wantIP: "2001:db8::1",
		},
		{
			name: "IPv4 with port in RemoteAddr correctly stripped",
			reqBuilder: func() *http.Request {
				r := httptest.NewRequest("GET", "/", nil)
				r.RemoteAddr = "192.0.2.1:54321"
				return r
			},
			wantIP: "192.0.2.1",
		},
		{
			name: "invalid garbage IP falls back to unknown",
			reqBuilder: func() *http.Request {
				r := httptest.NewRequest("GET", "/", nil)
				r.RemoteAddr = "invalid-ip-string"
				return r
			},
			wantIP: "unknown",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractClientIP(tt.reqBuilder())
			assert.Equal(t, tt.wantIP, got)
		})
	}
}

// ── 10. ConnLimiter 隔离与双层配额测试 ──────────────────────────

// ── 11. SSE 网关端点 HTTP 429 与生命周期重连测试 ──────────────
func TestSSEGateway_ConcurrencyAndLifetime(t *testing.T) {
	tests := []struct {
		name string
		test func(t *testing.T)
	}{
		{
			name: "notifications endpoint returns 429 when user exceeds max concurrency",
			test: func(t *testing.T) {
				cfg := Config{
					InternalToken:      "secret-internal",
					SseMaxConnsPerUser: 1, // 单用户上限 1
				}
				store := newFakeSSEStore(t)
				store.notifSnaps["user-concurrency-test"] = &NotificationSnapshot{UnreadCount: 1}
				gw := NewGateway(cfg, store)

				// 占用唯一的并发槽位
				rel, err := gw.limiter.Acquire("user-concurrency-test", "127.0.0.1")
				require.NoError(t, err)
				defer rel()

				// 发起 HTTP 请求
				rec := httptest.NewRecorder()
				req := httptest.NewRequest("GET", "/api/notifications/stream", nil)
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("x-user-id", "user-concurrency-test")

				gw.HandleNotifications(rec, req)
				assert.Equal(t, http.StatusTooManyRequests, rec.Code)
				assert.Equal(t, "5", rec.Header().Get("Retry-After"))
				assert.Contains(t, rec.Body.String(), "Too many concurrent SSE connections")
			},
		},
		{
			name: "ingest jobs endpoint exits cleanly and emits lifetime_refresh when lifetime expires",
			test: func(t *testing.T) {
				cfg := Config{
					InternalToken:       "secret-internal",
					SseJobMaxLifetimeMs: 50, // 50ms 快速超时测试
				}
				store := newFakeSSEStore(t)
				jobId := "job-lifetime-test"
				store.jobs[jobId] = &ImportJobSnapshot{
					ID:        jobId,
					UserID:    "user-lifetime",
					Status:    "SCANNING", // 保持非终态
					CreatedAt: time.Now(),
				}
				gw := NewGateway(cfg, store)

				rec := httptest.NewRecorder()
				req := httptest.NewRequest("GET", "/api/ingest-jobs/"+jobId+"/events", nil)
				req.SetPathValue("id", jobId)
				req.Header.Set("x-internal-token", "secret-internal")
				req.Header.Set("x-user-id", "user-lifetime")

				start := time.Now()
				gw.HandleIngestJobEvents(rec, req)
				duration := time.Since(start)

				assert.Equal(t, http.StatusOK, rec.Code)
				assert.Contains(t, rec.Body.String(), ": lifetime_refresh")
				assert.True(t, duration >= 45*time.Millisecond, "should wait for lifetime timer")
				// 协程与连接数必须已被完全释放归零
				assert.Equal(t, 0, gw.limiter.UserCount("user-lifetime"))
				assert.Equal(t, int64(0), gw.limiter.GlobalCount())
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, tt.test)
	}
}
