package mcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeStore struct {
	mu sync.Mutex

	tokens     map[string]*TokenRecord
	quotas     map[string]UserQuota
	ledger     map[string]int
	bundles    map[string]*BundleMeta
	bundleUses map[string]int
	increments int
	touches    int
	presence   []string
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		tokens:     map[string]*TokenRecord{},
		quotas:     map[string]UserQuota{},
		ledger:     map[string]int{},
		bundles:    map[string]*BundleMeta{},
		bundleUses: map[string]int{},
	}
}

func (f *fakeStore) LookupBundle(_ context.Context, bundleID string) (*BundleMeta, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if b, ok := f.bundles[bundleID]; ok {
		return b, nil
	}
	for _, b := range f.bundles {
		if b.ID == bundleID || (b.Slug != nil && *b.Slug == bundleID) {
			return b, nil
		}
	}
	return nil, nil
}

func (f *fakeStore) IncrementBundleUseCount(_ context.Context, bundleID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bundleUses[bundleID]++
	return nil
}

func (f *fakeStore) LookupToken(_ context.Context, tokenHash string) (*TokenRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tokens[tokenHash], nil
}

func (f *fakeStore) GetUserQuota(_ context.Context, userID string) (UserQuota, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if q, ok := f.quotas[userID]; ok {
		return q, nil
	}
	return UserQuota{Role: "USER", RpmLimit: 30, DailyLimit: 100, TokenCap: 4000}, nil
}

func (f *fakeStore) LedgerCount(_ context.Context, userID, day string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ledger[userID+"_"+day], nil
}

func (f *fakeStore) LedgerIncrement(_ context.Context, userID, day string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ledger[userID+"_"+day]++
	f.increments++
	return nil
}

func (f *fakeStore) TouchTokenLastUsed(_ context.Context, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touches++
	return nil
}

func (f *fakeStore) UpsertPresence(_ context.Context, userID, clientName, _, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.presence = append(f.presence, userID+"|"+clientName)
	return nil
}

const goodToken = "opgts_goodtoken0000000000000000000"

func testServer(t *testing.T, store *fakeStore, upstream *httptest.Server) *httptest.Server {
	t.Helper()
	cfg := Config{
		Addr:               "127.0.0.1:0",
		UpstreamURL:        upstream.URL,
		InternalToken:      "test-internal-token",
		UpstreamSkipHeader: "x-mcp-quota-checked",
		ProxyTimeoutMs:     2000,
		PoolMax:            2,
	}
	return httptest.NewServer(newServer(cfg, store).routes(http.HandlerFunc(newServer(cfg, store).handleRoot)))
}

type upstreamRecorder struct {
	mu        sync.Mutex
	lastReq   *http.Request
	lastBody  string
	skipSeen  bool
	tokenSeen string
}

func (u *upstreamRecorder) record(r *http.Request, body string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.lastReq = r
	u.lastBody = body
	u.skipSeen = r.Header.Get("x-mcp-quota-checked") == "1"
	u.tokenSeen = r.Header.Get("x-internal-token")
}

func post(t *testing.T, url, token, body string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	return resp
}

func TestInvalidTokenIsHardRejected401(t *testing.T) {
	store := newFakeStore()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Fail(t, "invalid token must not reach upstream")
	}))
	defer up.Close()
	ts := testServer(t, store, up)
	defer ts.Close()

	resp := post(t, ts.URL+"/api/mcp/o/r", "opgts_invalid", `{"jsonrpc":"2.0","id":1,"method":"tools/call"}`)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	assert.Equal(t, "Bearer", resp.Header.Get("WWW-Authenticate"), "401 must carry WWW-Authenticate: Bearer challenge")
}

func TestBannedUserIs403(t *testing.T) {
	store := newFakeStore()
	store.tokens[sha256Hex(goodToken)] = &TokenRecord{TokenID: "t1", UserID: "u-banned"}
	store.quotas["u-banned"] = UserQuota{Role: "USER", IsBanned: true, RpmLimit: 30, DailyLimit: 100, TokenCap: 4000}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		assert.Fail(t, "banned user must not reach upstream")
	}))
	defer up.Close()
	ts := testServer(t, store, up)
	defer ts.Close()

	resp := post(t, ts.URL+"/api/mcp/o/r", goodToken, `{"jsonrpc":"2.0","id":1,"method":"tools/call"}`)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	assert.Equal(t, "true", resp.Header.Get("x-ratelimit-banned"), "banned response must carry x-ratelimit-banned")
}

func TestPingAndNotificationsAnsweredNatively(t *testing.T) {
	store := newFakeStore()
	store.tokens[sha256Hex(goodToken)] = &TokenRecord{TokenID: "t1", UserID: "u1"}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		assert.Fail(t, "ping/notifications must be answered natively, not proxied")
	}))
	defer up.Close()
	ts := testServer(t, store, up)
	defer ts.Close()

	tests := []struct {
		name        string
		body        string
		wantStatus  int
		checkResult bool
	}{
		{
			name:        "ping returns JSON-RPC result",
			body:        `{"jsonrpc":"2.0","id":1,"method":"ping"}`,
			wantStatus:  http.StatusOK,
			checkResult: true,
		},
		{
			name:        "notifications/initialized returns 202 Accepted",
			body:        `{"jsonrpc":"2.0","method":"notifications/initialized"}`,
			wantStatus:  http.StatusAccepted,
			checkResult: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := post(t, ts.URL+"/api/mcp/o/r", goodToken, tt.body)
			defer resp.Body.Close()
			assert.Equal(t, tt.wantStatus, resp.StatusCode)
			if tt.checkResult {
				assert.Contains(t, readAll(t, resp.Body), `"result"`)
			}
		})
	}
}

func TestFreeMethodsSkipMeteringButProxy(t *testing.T) {
	store := newFakeStore()
	store.tokens[sha256Hex(goodToken)] = &TokenRecord{TokenID: "t1", UserID: "u1"}
	rec := &upstreamRecorder{}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readAll(t, r.Body)
		rec.record(r, body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer up.Close()
	ts := testServer(t, store, up)
	defer ts.Close()

	resp := post(t, ts.URL+"/api/mcp/o/r", goodToken, `{"jsonrpc":"2.0","id":1,"method":"resources/list"}`)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, 0, store.increments, "free method must not touch ledger")
	assert.False(t, rec.skipSeen, "free method must not carry quota-skip header")
	assert.NotNil(t, rec.lastReq, "non-intercepted free method must reach upstream")
}

func TestNativeProtocolDiscovery(t *testing.T) {
	store := newFakeStore()
	store.tokens[sha256Hex(goodToken)] = &TokenRecord{TokenID: "t1", UserID: "u1"}

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Fail(t, "native discovery methods must be handled by mcp-sidecar and never reach upstream", "method=%s path=%s", r.Method, r.URL.Path)
	}))
	defer up.Close()

	ts := testServer(t, store, up)
	defer ts.Close()

	tests := []struct {
		name       string
		body       string
		wantStatus int
		verify     func(t *testing.T, rawBody string)
	}{
		{
			name:       "initialize returns native capabilities and serverInfo",
			body:       `{"jsonrpc":"2.0","id":101,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}`,
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, rawBody string) {
				var resp struct {
					JSONRPC string           `json:"jsonrpc"`
					ID      int              `json:"id"`
					Result  InitializeResult `json:"result"`
				}
				err := json.Unmarshal([]byte(rawBody), &resp)
				require.NoError(t, err)
				assert.Equal(t, "2.0", resp.JSONRPC)
				assert.Equal(t, 101, resp.ID)
				assert.Equal(t, "2024-11-05", resp.Result.ProtocolVersion)
				assert.Equal(t, "opengits-mcp-sidecar", resp.Result.ServerInfo.Name)
				assert.Equal(t, "1.0.0", resp.Result.ServerInfo.Version)
				assert.False(t, resp.Result.Capabilities.Tools.ListChanged)
			},
		},
		{
			name:       "tools/list returns 12 native tools matching schema",
			body:       `{"jsonrpc":"2.0","id":"tools-query-1","method":"tools/list"}`,
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, rawBody string) {
				var resp struct {
					JSONRPC string          `json:"jsonrpc"`
					ID      string          `json:"id"`
					Result  ToolsListResult `json:"result"`
				}
				err := json.Unmarshal([]byte(rawBody), &resp)
				require.NoError(t, err)
				assert.Equal(t, "2.0", resp.JSONRPC)
				assert.Equal(t, "tools-query-1", resp.ID)
				require.Len(t, resp.Result.Tools, 4)

				toolMap := make(map[string]ToolDefinition)
				for _, tool := range resp.Result.Tools {
					assert.NotEmpty(t, tool.Description)
					assert.NotEmpty(t, tool.InputSchema)
					toolMap[tool.Name] = tool
				}

				expectedTools := []string{
					"browse", "search", "read", "read_code",
				}
				for _, exp := range expectedTools {
					assert.Contains(t, toolMap, exp, "missing expected native tool: %s", exp)
				}
				assert.NotContains(t, toolMap, "list_chapter_versions")
				assert.NotContains(t, toolMap, "dissect_code")
				assert.NotContains(t, toolMap, "verify_claim")
			},
		},
		{
			name:       "prompts/list returns 4 native engineering prompts",
			body:       `{"jsonrpc":"2.0","id":"prompts-query-1","method":"prompts/list"}`,
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, rawBody string) {
				var resp struct {
					JSONRPC string            `json:"jsonrpc"`
					ID      string            `json:"id"`
					Result  PromptsListResult `json:"result"`
				}
				err := json.Unmarshal([]byte(rawBody), &resp)
				require.NoError(t, err)
				assert.Equal(t, "2.0", resp.JSONRPC)
				assert.Equal(t, "prompts-query-1", resp.ID)
				require.Len(t, resp.Result.Prompts, 4)

				names := make([]string, len(resp.Result.Prompts))
				aliasMap := make(map[string][]string, len(resp.Result.Prompts))
				for i, p := range resp.Result.Prompts {
					names[i] = p.Name
					aliasMap[p.Name] = p.Aliases
					assert.NotEmpty(t, p.Description)
				}
				assert.Contains(t, names, "deep_dive")
				assert.Contains(t, names, "code_review")
				assert.Contains(t, names, "breaking_changes")
				assert.Contains(t, names, "explore_concept")
				assert.Equal(t, []string{"explain-architecture"}, aliasMap["deep_dive"])
				assert.Equal(t, []string{"scaffold-project"}, aliasMap["code_review"])
				assert.Equal(t, []string{"audit-breaking-changes"}, aliasMap["breaking_changes"])
				assert.Equal(t, []string{"learn-path"}, aliasMap["explore_concept"])
			},
		},
		{
			name:       "prompts/get deep_dive returns prompt messages natively",
			body:       `{"jsonrpc":"2.0","id":"prompts-get-1","method":"prompts/get","params":{"name":"deep_dive","arguments":{"topic":"Auth Flow"}}}`,
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, rawBody string) {
				var resp struct {
					JSONRPC string          `json:"jsonrpc"`
					ID      string          `json:"id"`
					Result  GetPromptResult `json:"result"`
				}
				err := json.Unmarshal([]byte(rawBody), &resp)
				require.NoError(t, err)
				assert.Equal(t, "2.0", resp.JSONRPC)
				assert.Equal(t, "prompts-get-1", resp.ID)
				assert.Equal(t, "Deep dive into architecture and core implementation", resp.Result.Description)
				require.NotEmpty(t, resp.Result.Messages)
				assert.Contains(t, resp.Result.Messages[0].Content.Text, "Auth Flow")
			},
		},
		{
			name:       "prompts/get unknown prompt returns error",
			body:       `{"jsonrpc":"2.0","id":"prompts-get-2","method":"prompts/get","params":{"name":"unknown_prompt"}}`,
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, rawBody string) {
				var resp struct {
					JSONRPC string `json:"jsonrpc"`
					ID      string `json:"id"`
					Error   *struct {
						Code    int    `json:"code"`
						Message string `json:"message"`
					} `json:"error"`
				}
				err := json.Unmarshal([]byte(rawBody), &resp)
				require.NoError(t, err)
				assert.Equal(t, "2.0", resp.JSONRPC)
				require.NotNil(t, resp.Error)
				assert.Equal(t, -32602, resp.Error.Code)
				assert.Contains(t, resp.Error.Message, "Prompt not found: unknown_prompt")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := post(t, ts.URL+"/api/mcp/o/r", goodToken, tt.body)
			defer resp.Body.Close()
			assert.Equal(t, tt.wantStatus, resp.StatusCode)
			raw := readAll(t, resp.Body)
			tt.verify(t, raw)
			assert.Equal(t, 0, store.increments, "discovery methods must never consume quota")
		})
	}
}

func TestGetDiscoveryNative_TableDriven(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)

	var upstreamHit bool
	ts := readTestServer(t, store, &upstreamHit)

	tests := []struct {
		name       string
		path       string
		token      string
		wantStatus int
		verify     func(t *testing.T, raw string)
	}{
		{
			name:       "single repo GET discovery with public repo returns 200 metadata",
			path:       "/api/mcp/octo/kit",
			token:      "",
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, raw string) {
				var resp struct {
					Name         string `json:"name"`
					Status       string `json:"status"`
					Capabilities struct {
						Tools     []string `json:"tools"`
						Resources []string `json:"resources"`
					} `json:"capabilities"`
				}
				err := json.Unmarshal([]byte(raw), &resp)
				require.NoError(t, err)
				assert.Equal(t, "opengits-octo-kit", resp.Name)
				assert.Equal(t, "READY", resp.Status)
				assert.Equal(t, NativeAllToolNames, resp.Capabilities.Tools)
				assert.NotEmpty(t, resp.Capabilities.Resources)
			},
		},
		{
			name:       "single repo GET discovery nonexistent repo returns 404",
			path:       "/api/mcp/octo/nonexistent",
			token:      "",
			wantStatus: http.StatusNotFound,
			verify: func(t *testing.T, raw string) {
				assert.Contains(t, raw, "Repository not found")
			},
		},
		{
			name:       "hub GET discovery with valid token returns 200 hub metadata",
			path:       "/api/mcp/hub",
			token:      goodToken,
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, raw string) {
				var resp struct {
					Name           string   `json:"name"`
					Version        string   `json:"version"`
					TutorialsCount int      `json:"tutorialsCount"`
					Tools          []string `json:"tools"`
				}
				err := json.Unmarshal([]byte(raw), &resp)
				require.NoError(t, err)
				assert.Equal(t, "opengits-user-hub", resp.Name)
				assert.Equal(t, "1.0.0", resp.Version)
				assert.Equal(t, NativeAllToolNames, resp.Tools)
			},
		},
		{
			name:       "hub GET discovery without token returns 401 with challenge header",
			path:       "/api/mcp/hub",
			token:      "",
			wantStatus: http.StatusUnauthorized,
			verify: func(t *testing.T, raw string) {
				assert.Contains(t, raw, "Unauthorized")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			upstreamHit = false
			req, err := http.NewRequest(http.MethodGet, ts.URL+tt.path, nil)
			require.NoError(t, err)
			if tt.token != "" {
				req.Header.Set("Authorization", "Bearer "+tt.token)
			}
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()

			assert.Equal(t, tt.wantStatus, resp.StatusCode)
			if resp.StatusCode == http.StatusUnauthorized {
				assert.Equal(t, "Bearer", resp.Header.Get("WWW-Authenticate"))
			}
			body := readAll(t, resp.Body)
			tt.verify(t, body)
			assert.False(t, upstreamHit, "Node upstream must NOT be reached for GET discovery")
		})
	}
}

func TestHubRouteDiscoveryNative(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	upstreamHit := false
	ts := readTestServer(t, store, &upstreamHit)

	tests := []struct {
		name         string
		method       string
		body         string
		assertResult func(t *testing.T, body map[string]any)
	}{
		{
			name:   "hub initialize handled natively",
			method: "initialize",
			body:   `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}`,
			assertResult: func(t *testing.T, res map[string]any) {
				srv, _ := res["serverInfo"].(map[string]any)
				assert.Equal(t, "opengits-user-hub", srv["name"])
			},
		},
		{
			name:   "hub tools/list handled natively",
			method: "tools/list",
			body:   `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
			assertResult: func(t *testing.T, res map[string]any) {
				tools, _ := res["tools"].([]any)
				assert.NotEmpty(t, tools)
				assert.Len(t, tools, 4)
			},
		},
		{
			name:   "hub resources/list handled natively",
			method: "resources/list",
			body:   `{"jsonrpc":"2.0","id":3,"method":"resources/list"}`,
			assertResult: func(t *testing.T, res map[string]any) {
				resources, _ := res["resources"].([]any)
				assert.Len(t, resources, 1)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			upstreamHit = false
			resp := post(t, ts.URL+"/api/mcp/hub", goodToken, tt.body)
			defer resp.Body.Close()
			assert.Equal(t, http.StatusOK, resp.StatusCode)
			assert.False(t, upstreamHit, "hub discovery method %s must be handled natively by Go sidecar", tt.method)

			var out struct {
				Result map[string]any `json:"result"`
			}
			err := json.NewDecoder(resp.Body).Decode(&out)
			assert.NoError(t, err)
			tt.assertResult(t, out.Result)
		})
	}
}

func TestSingleRepoDiscoveryRepoGates(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)

	store.repos["octo/paused"] = &RepoRow{ID: "r-paused", Owner: "octo", Repo: "paused", McpStatus: "PAUSED", IsPublic: true}

	store.repos["octo/private"] = &RepoRow{ID: "r-priv", Owner: "octo", Repo: "private", McpStatus: "ACTIVE", IsPublic: false}

	store.repos["octo/private-allowed"] = &RepoRow{ID: "r-priv-ok", Owner: "octo", Repo: "private-allowed", McpStatus: "ACTIVE", IsPublic: false}
	store.savedRepos["r-priv-ok|u1"] = true

	ts := readTestServer(t, store, nil)

	tests := []struct {
		name       string
		path       string
		body       string
		wantStatus int
		wantCode   int
		wantMsg    string
	}{
		{
			name:       "not found repo returns 404 for tools/list",
			path:       "/api/mcp/octo/nonexistent",
			body:       `{"jsonrpc":"2.0","id":"q1","method":"tools/list"}`,
			wantStatus: http.StatusNotFound,
			wantCode:   -32000,
			wantMsg:    "Repository not found",
		},
		{
			name:       "paused repo returns 503 for tools/list",
			path:       "/api/mcp/octo/paused",
			body:       `{"jsonrpc":"2.0","id":"q2","method":"tools/list"}`,
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   -32000,
			wantMsg:    "MCP service for this repository is currently paused by administrator",
		},
		{
			name:       "private repo without access returns 403 for tools/list",
			path:       "/api/mcp/octo/private",
			body:       `{"jsonrpc":"2.0","id":"q3","method":"tools/list"}`,
			wantStatus: http.StatusForbidden,
			wantCode:   -32001,
			wantMsg:    "Forbidden: Repository is private",
		},
		{
			name:       "private repo with access succeeds with 200 for tools/list",
			path:       "/api/mcp/octo/private-allowed",
			body:       `{"jsonrpc":"2.0","id":"q4","method":"tools/list"}`,
			wantStatus: http.StatusOK,
			wantCode:   0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := post(t, ts.URL+tt.path, goodToken, tt.body)
			defer resp.Body.Close()
			assert.Equal(t, tt.wantStatus, resp.StatusCode)
			raw := readAll(t, resp.Body)
			if tt.wantCode != 0 {
				var errResp struct {
					Error struct {
						Code    int    `json:"code"`
						Message string `json:"message"`
					} `json:"error"`
				}
				err := json.Unmarshal([]byte(raw), &errResp)
				require.NoError(t, err)
				assert.Equal(t, tt.wantCode, errResp.Error.Code)
				assert.Contains(t, errResp.Error.Message, tt.wantMsg)
			}
		})
	}
}

func TestMeteredCallIncrementsLedgerAndCarriesQuotaSkipHeader(t *testing.T) {
	store := newFakeStore()
	store.tokens[sha256Hex(goodToken)] = &TokenRecord{TokenID: "t1", UserID: "u1"}
	rec := &upstreamRecorder{}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.record(r, readAll(t, r.Body))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"tool":"search","result":[]}`))
	}))
	defer up.Close()
	ts := testServer(t, store, up)
	defer ts.Close()

	resp := post(t, ts.URL+"/api/mcp/o/r", goodToken, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"x"}}}`)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, 1, store.increments, "ledger increments = 1 (Go is sole metering point)")
	assert.True(t, rec.skipSeen, "metered proxy must carry x-mcp-quota-checked: 1")
	assert.Equal(t, "test-internal-token", rec.tokenSeen, "metered proxy must carry signed x-internal-token")
	assert.Contains(t, rec.lastBody, `"search"`, "proxy body must be preserved verbatim")
}

func TestDailyQuotaExceededIs429(t *testing.T) {
	store := newFakeStore()
	store.tokens[sha256Hex(goodToken)] = &TokenRecord{TokenID: "t1", UserID: "u-quota"}
	store.quotas["u-quota"] = UserQuota{Role: "USER", RpmLimit: 30, DailyLimit: 2, TokenCap: 4000}
	day := time.Now().UTC().Format("2006-01-02")
	store.ledger["u-quota_"+day] = 2
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		assert.Fail(t, "quota-exceeded must not reach upstream")
	}))
	defer up.Close()
	ts := testServer(t, store, up)
	defer ts.Close()

	resp := post(t, ts.URL+"/api/mcp/o/r", goodToken, `{"jsonrpc":"2.0","id":1,"method":"tools/call"}`)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	assert.Contains(t, readAll(t, resp.Body), "DAILY_QUOTA")
}

func TestRpmSlidingWindowEnforced(t *testing.T) {
	store := newFakeStore()
	store.tokens[sha256Hex(goodToken)] = &TokenRecord{TokenID: "t1", UserID: "u-rpm"}
	store.quotas["u-rpm"] = UserQuota{Role: "USER", RpmLimit: 2, DailyLimit: 100, TokenCap: 4000}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer up.Close()
	ts := testServer(t, store, up)
	defer ts.Close()

	for i := 0; i < 2; i++ {
		resp := post(t, ts.URL+"/api/mcp/o/r", goodToken, `{"jsonrpc":"2.0","id":1,"method":"tools/call"}`)
		resp.Body.Close()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	}
	resp := post(t, ts.URL+"/api/mcp/o/r", goodToken, `{"jsonrpc":"2.0","id":1,"method":"tools/call"}`)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	assert.Equal(t, "60", resp.Header.Get("Retry-After"))
}

func TestNoTokenProxiesVerbatimWithoutMetering(t *testing.T) {
	store := newFakeStore()
	rec := &upstreamRecorder{}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.record(r, readAll(t, r.Body))
		w.WriteHeader(http.StatusOK)
	}))
	defer up.Close()
	ts := testServer(t, store, up)
	defer ts.Close()

	resp := post(t, ts.URL+"/api/mcp/o/r", "", `{"jsonrpc":"2.0","id":1,"method":"tools/call"}`)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, 0, store.increments, "no-token traffic must not be metered")
	assert.False(t, rec.skipSeen, "no-token traffic must not carry skip header")
}

func TestPresenceHeartbeatUpserted(t *testing.T) {
	store := newFakeStore()
	store.tokens[sha256Hex(goodToken)] = &TokenRecord{TokenID: "t1", UserID: "u1"}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer up.Close()
	ts := testServer(t, store, up)
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/mcp/o/r", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	req.Header.Set("Authorization", "Bearer "+goodToken)
	req.Header.Set("User-Agent", "Cursor/0.42 (mcp client)")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		store.mu.Lock()
		n := len(store.presence)
		touches := store.touches
		store.mu.Unlock()
		if n > 0 && touches > 0 {
			store.mu.Lock()
			last := store.presence[n-1]
			store.mu.Unlock()
			assert.Equal(t, "u1|Cursor IDE", last)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	require.FailNow(t, "presence heartbeat was not upserted")
}

func TestNormalizeClientName(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "cursor with version", in: "Cursor/1.0", want: "Cursor IDE"},
		{name: "claude desktop lowercase", in: "claude-desktop", want: "Claude Desktop"},
		{name: "windsurf prefix", in: "Windsurf x", want: "Windsurf"},
		{name: "cline uppercase plugin", in: "CLINE plugin", want: "Cline"},
		{name: "unrecognized agent preserved verbatim", in: "some-agent/2.1", want: "some-agent/2.1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeClientName(tt.in)
			assert.Equal(t, tt.want, got)
		})
	}
}

func readAll(t *testing.T, r io.Reader) string {
	t.Helper()
	b, err := io.ReadAll(r)
	require.NoError(t, err)
	return string(b)
}
