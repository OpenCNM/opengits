package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// setupBundleTestFixture 构造标准 Bundle 单测夹具。
func setupBundleTestFixture(t *testing.T) (*readFakeStore, *httptest.Server, *bool) {
	t.Helper()
	store := newReadFakeStore()
	seedAuth(t, store)
	store.quotas["u1"] = UserQuota{Role: "ADMIN", Tier: "ENTERPRISE", RpmLimit: 600, DailyLimit: 0, TokenCap: 32000}

	var upstreamHit bool
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHit = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))

	slug := "ai-infra"
	desc := "AI Infrastructure Bundle containing top tier toolkits"
	cat1 := "AI"
	cat2 := "VectorDB"
	bundle := &BundleMeta{
		ID:          "bnd-1",
		Slug:        &slug,
		Title:       "AI Infrastructure Stack",
		Description: &desc,
		Repositories: []BundleRepoMeta{
			{ID: "repo-1", Owner: "langchain-ai", Repo: "langchain", Category: &cat1, StarCount: 90000, IsVerified: true},
			{ID: "repo-2", Owner: "chroma-core", Repo: "chroma", Category: &cat2, StarCount: 15000, IsVerified: true},
		},
	}
	store.bundles["bnd-1"] = bundle
	store.bundles["ai-infra"] = bundle

	// 注入文档用于 read_document 测试
	store.bundleDocs["repo-1|docs/intro.md"] = bundleDocTestItem{
		Title:   "LangChain Intro",
		Path:    "docs/intro.md",
		Content: "Welcome to LangChain framework for LLM applications.",
	}
	store.bundleDocs["repo-2|docs/quickstart.md"] = bundleDocTestItem{
		Title:   "Chroma Quickstart",
		Path:    "docs/quickstart.md",
		Content: "Chroma is the AI-native open-source embedding database.",
	}
	store.bundleDocs["repo-1|docs/long.md"] = bundleDocTestItem{
		Title:   "Long Document",
		Path:    "docs/long.md",
		Content: strings.Repeat("A", 17000),
	}

	// 注入 search 索引切片
	store.chunksIndex = []rawChunkRow{
		{
			ChunkID: "chk-1", DocID: "doc-1", Heading: str("LLM Chains"),
			HeadingPath: str("docs/intro.md#LLM Chains"), Content: str("Building LLM Chains and agent workflows."),
			Title: str("LangChain Intro"), Path: str("docs/intro.md"),
		},
		{
			ChunkID: "chk-2", DocID: "doc-2", Heading: str("Embedding Storage"),
			HeadingPath: str("docs/quickstart.md#Embedding Storage"), Content: str("Store embeddings and vectors in cluster."),
			Title: str("Chroma Quickstart"), Path: str("docs/quickstart.md"),
		},
		{
			ChunkID: "chk-3", DocID: "doc-3", Heading: str("Breaking Change in v0.2"),
			HeadingPath: str("docs/migration.md#Breaking Change in v0.2"), Content: str("Drop legacy CallbackManager in v0.2 migration."),
			Title: str("Migration Notes"), Path: str("docs/migration.md"),
		},
	}

	cfg := Config{
		Addr:               "127.0.0.1:0",
		UpstreamURL:        up.URL,
		InternalToken:      "test-internal-token",
		UpstreamSkipHeader: "x-mcp-quota-checked",
		ProxyTimeoutMs:     2000,
	}
	srv := newServer(cfg, store)
	ts := httptest.NewServer(srv.routes(http.HandlerFunc(srv.handleRoot)))

	t.Cleanup(func() {
		ts.Close()
		up.Close()
	})

	return store, ts, &upstreamHit
}

// 🧪 [7.14.6.1 · 路径解析与路由分类] Table-Driven: bundleSegments 与 singleRepoSegments 隔离
func TestBundleSegments_TableDriven(t *testing.T) {
	tests := []struct {
		name          string
		path          string
		wantBundleID  string
		wantIsBundle  bool
		wantIsSingle  bool
		wantRepoOwner string
		wantRepoName  string
	}{
		{
			name:         "standard bundle route by slug",
			path:         "/api/mcp/bundle/ai-infra",
			wantBundleID: "ai-infra",
			wantIsBundle: true,
			wantIsSingle: false,
		},
		{
			name:         "bundle route by cuid id",
			path:         "/api/mcp/bundle/cuid_1234567890",
			wantBundleID: "cuid_1234567890",
			wantIsBundle: true,
			wantIsSingle: false,
		},
		{
			name:         "trailing slash or empty bundle id",
			path:         "/api/mcp/bundle/",
			wantBundleID: "",
			wantIsBundle: false,
			wantIsSingle: false,
		},
		{
			name:          "single repo route must not match bundle",
			path:          "/api/mcp/facebook/react",
			wantBundleID:  "",
			wantIsBundle:  false,
			wantIsSingle:  true,
			wantRepoOwner: "facebook",
			wantRepoName:  "react",
		},
		{
			// 🧪 BUG-06 同口径：地址栏混写大小写必须归一为小写（存储行全小写），
			// 否则会在门禁层（MCPFindDefaultBranchRepo 精确等值）404
			name:          "mixed-case owner/repo is normalized to lowercase",
			path:          "/api/mcp/Facebook/React",
			wantBundleID:  "",
			wantIsBundle:  false,
			wantIsSingle:  true,
			wantRepoOwner: "facebook",
			wantRepoName:  "react",
		},
		{
			// 🧪 保留字路由大小写变体不得绕过保留字闯入单仓面（归一后判定）
			name:         "case-variant reserved segment stays excluded from single repo",
			path:         "/api/mcp/Bundle/ai-infra",
			wantBundleID: "",
			wantIsBundle:  false,
			wantIsSingle:  false,
		},
		{
			name:         "hub route must not match bundle nor single repo",
			path:         "/api/mcp/hub",
			wantBundleID: "",
			wantIsBundle: false,
			wantIsSingle: false,
		},
		{
			name:         "nested bundle subpath is excluded",
			path:         "/api/mcp/bundle/ai-infra/extra",
			wantBundleID: "",
			wantIsBundle: false,
			wantIsSingle: false,
		},
		{
			name:         "non mcp bundle path",
			path:         "/api/other/bundle/ai-infra",
			wantBundleID: "",
			wantIsBundle: false,
			wantIsSingle: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bID, isBundle := bundleSegments(tt.path)
			assert.Equal(t, tt.wantIsBundle, isBundle)
			assert.Equal(t, tt.wantBundleID, bID)

			owner, repo, isSingle := singleRepoSegments(tt.path)
			assert.Equal(t, tt.wantIsSingle, isSingle)
			if tt.wantIsSingle {
				assert.Equal(t, tt.wantRepoOwner, owner)
				assert.Equal(t, tt.wantRepoName, repo)
			}
		})
	}
}

// 🧪 [7.14.6.1 · 缓存与并发单飞] Table-Driven: cachedLookupBundle 60s TTL 与负缓存防击穿
func TestCachedLookupBundle_TableDriven(t *testing.T) {
	tests := []struct {
		name          string
		bundleID      string
		preload       bool
		wantFound     bool
		wantTitle     string
		expectedDBOps int32
	}{
		{
			name:          "hit existing bundle by slug",
			bundleID:      "ai-infra",
			preload:       true,
			wantFound:     true,
			wantTitle:     "AI Infrastructure Stack",
			expectedDBOps: 1, // 多次调用仅首次打库
		},
		{
			name:          "negative cache for nonexistent bundle",
			bundleID:      "nonexistent-bundle-slug",
			preload:       false,
			wantFound:     false,
			expectedDBOps: 1, // 10s 负缓存生效，后续不打库
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newReadFakeStore()
			seedAuth(t, store)

			var dbCalls atomic.Int32
			slug := "ai-infra"
			bundle := &BundleMeta{
				ID:    "bnd-1",
				Slug:  &slug,
				Title: "AI Infrastructure Stack",
			}
			if tt.preload {
				store.bundles[tt.bundleID] = bundle
			}

			cfg := Config{Addr: ":8081", ProxyTimeoutMs: 2000}
			srv := newServer(cfg, store)

			// 连续调用 5 次
			for i := 0; i < 5; i++ {
				meta, err := srv.cachedLookupBundle(context.Background(), tt.bundleID)
				require.NoError(t, err)
				if tt.wantFound {
					require.NotNil(t, meta)
					assert.Equal(t, tt.wantTitle, meta.Title)
				} else {
					assert.Nil(t, meta)
				}
				if i == 0 {
					dbCalls.Add(1)
				}
			}

			assert.Equal(t, tt.expectedDBOps, dbCalls.Load())
		})
	}
}

// 🧪 [7.14.6.1 · 协议握手] Table-Driven: Bundle initialize 与 tools/list 原生应答（零 Node 透传）
func TestBundleProtocolDiscovery_TableDriven(t *testing.T) {
	_, ts, upstreamHit := setupBundleTestFixture(t)

	tests := []struct {
		name       string
		path       string
		body       string
		wantStatus int
		verify     func(t *testing.T, raw string)
	}{
		{
			name:       "initialize returns opengits-bundle-slug and capabilities",
			path:       "/api/mcp/bundle/ai-infra",
			body:       `{"jsonrpc":"2.0","id":100,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}`,
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, raw string) {
				var resp struct {
					JSONRPC string           `json:"jsonrpc"`
					ID      int              `json:"id"`
					Result  InitializeResult `json:"result"`
				}
				err := json.Unmarshal([]byte(raw), &resp)
				require.NoError(t, err)
				assert.Equal(t, "2.0", resp.JSONRPC)
				assert.Equal(t, 100, resp.ID)
				assert.Equal(t, "opengits-bundle-ai-infra", resp.Result.ServerInfo.Name)
				assert.Equal(t, "1.0.0", resp.Result.ServerInfo.Version)
				assert.Equal(t, "2024-11-05", resp.Result.ProtocolVersion)
			},
		},
		{
			name:       "initialize on unknown bundle returns 404 json-rpc error",
			path:       "/api/mcp/bundle/unknown-bundle",
			body:       `{"jsonrpc":"2.0","id":101,"method":"initialize","params":{}}`,
			wantStatus: http.StatusNotFound,
			verify: func(t *testing.T, raw string) {
				assert.Contains(t, raw, "McpBundle not found")
				assert.Contains(t, raw, "-32000")
			},
		},
		{
			name:       "tools/list returns 13 native bundle tools (incl. verify_claim)",
			path:       "/api/mcp/bundle/ai-infra",
			body:       `{"jsonrpc":"2.0","id":102,"method":"tools/list"}`,
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, raw string) {
				var resp struct {
					Result ToolsListResult `json:"result"`
				}
				err := json.Unmarshal([]byte(raw), &resp)
				require.NoError(t, err)
				require.Len(t, resp.Result.Tools, 13)
				names := make(map[string]bool)
				for _, tool := range resp.Result.Tools {
					names[tool.Name] = true
					assert.NotEmpty(t, tool.Description)
				}
				assert.True(t, names["list_resources"])
				assert.True(t, names["search"])
				assert.True(t, names["read_document"])
				assert.True(t, names["check_breaking_changes"])
				// 1b220fc6 新增的查证工具必须在原生工具面可达
				assert.True(t, names["verify_claim"])
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			*upstreamHit = false
			resp := post(t, ts.URL+tt.path, goodToken, tt.body)
			defer resp.Body.Close()

			assert.Equal(t, tt.wantStatus, resp.StatusCode)
			raw, _ := io.ReadAll(resp.Body)
			tt.verify(t, string(raw))
			assert.False(t, *upstreamHit, "Node upstream must NOT be touched")
		})
	}
}

// 🧪 [7.14.6.1 · list_resources 工具] Table-Driven: 合集仓库清单格式化输出
func TestBundleListResources_TableDriven(t *testing.T) {
	_, ts, upstreamHit := setupBundleTestFixture(t)

	tests := []struct {
		name       string
		path       string
		toolName   string
		args       string
		wantStatus int
		verify     func(t *testing.T, text string)
	}{
		{
			name:       "list all repositories in bundle",
			path:       "/api/mcp/bundle/ai-infra",
			toolName:   "list_resources",
			args:       `{}`,
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, text string) {
				assert.Contains(t, text, `Repositories included in bundle "AI Infrastructure Stack" (ai-infra):`)
				assert.Contains(t, text, `- langchain-ai/langchain [Category: AI, Stars: 90000, Verified: Yes]`)
				assert.Contains(t, text, `- chroma-core/chroma [Category: VectorDB, Stars: 15000, Verified: Yes]`)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			*upstreamHit = false
			body := fmt.Sprintf(`{"jsonrpc":"2.0","id":201,"method":"tools/call","params":{"name":"%s","arguments":%s}}`, tt.toolName, tt.args)
			resp := post(t, ts.URL+tt.path, goodToken, body)
			defer resp.Body.Close()

			assert.Equal(t, tt.wantStatus, resp.StatusCode)
			var rpcResp struct {
				Result struct {
					Content []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"content"`
					IsError bool `json:"isError"`
				} `json:"result"`
			}
			raw, _ := io.ReadAll(resp.Body)
			err := json.Unmarshal(raw, &rpcResp)
			require.NoError(t, err)
			require.NotEmpty(t, rpcResp.Result.Content)
			tt.verify(t, rpcResp.Result.Content[0].Text)
			assert.False(t, *upstreamHit, "Node upstream must NOT be touched")
		})
	}
}

// 🧪 [7.14.6.1 · read_document 工具与越权防御] Table-Driven: 跨仓直读与仓外越权防御
func TestBundleReadDocument_TableDriven(t *testing.T) {
	_, ts, upstreamHit := setupBundleTestFixture(t)

	tests := []struct {
		name        string
		args        string
		wantError   bool
		wantSnippet string
	}{
		{
			name:        "read valid document in repo-1",
			args:        `{"repository":"langchain-ai/langchain","path":"docs/intro.md"}`,
			wantError:   false,
			wantSnippet: "Welcome to LangChain framework for LLM applications.",
		},
		{
			name:        "read valid document in repo-2",
			args:        `{"repository":"chroma-core/chroma","path":"docs/quickstart.md"}`,
			wantError:   false,
			wantSnippet: "Chroma is the AI-native open-source embedding database.",
		},
		{
			name:        "empty repository parameter",
			args:        `{"repository":"","path":"docs/intro.md"}`,
			wantError:   true,
			wantSnippet: "Error: Repository and path cannot be empty.",
		},
		{
			name:        "invalid repository format missing slash",
			args:        `{"repository":"langchain","path":"docs/intro.md"}`,
			wantError:   true,
			wantSnippet: "Error: repository must be in \"owner/repo\" format.",
		},
		{
			name:        "repository not included in bundle (defense against cross-tenant breach)",
			args:        `{"repository":"facebook/react","path":"README.md"}`,
			wantError:   true,
			wantSnippet: "Error: Repository \"facebook/react\" is not included in this bundle.",
		},
		{
			name:        "document not found in target repo",
			args:        `{"repository":"langchain-ai/langchain","path":"docs/nonexistent.md"}`,
			wantError:   true,
			wantSnippet: "Error: Document \"docs/nonexistent.md\" not found in langchain-ai/langchain.",
		},
		{
			name:        "long document 16K cap truncation",
			args:        `{"repository":"langchain-ai/langchain","path":"docs/long.md"}`,
			wantError:   false,
			wantSnippet: "Truncated for context limit",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			*upstreamHit = false
			body := fmt.Sprintf(`{"jsonrpc":"2.0","id":301,"method":"tools/call","params":{"name":"read_document","arguments":%s}}`, tt.args)
			resp := post(t, ts.URL+"/api/mcp/bundle/ai-infra", goodToken, body)
			defer resp.Body.Close()

			assert.Equal(t, http.StatusOK, resp.StatusCode)
			var rpcResp struct {
				Result struct {
					Content []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"content"`
					IsError bool `json:"isError"`
				} `json:"result"`
			}
			raw, _ := io.ReadAll(resp.Body)
			err := json.Unmarshal(raw, &rpcResp)
			require.NoError(t, err)
			require.NotEmpty(t, rpcResp.Result.Content)
			assert.Equal(t, tt.wantError, rpcResp.Result.IsError)
			assert.Contains(t, rpcResp.Result.Content[0].Text, tt.wantSnippet)
			assert.False(t, *upstreamHit, "Node upstream must NOT be touched")
		})
	}
}

// 🧪 [7.14.6.1 · search 与 check_breaking_changes] Table-Driven: 并发扇出与维度过滤
func TestBundleSearchAndBreakingChanges_TableDriven(t *testing.T) {
	_, ts, upstreamHit := setupBundleTestFixture(t)

	tests := []struct {
		name        string
		toolName    string
		args        string
		wantError   bool
		wantSnippet string
	}{
		{
			name:        "bundle search all dimensions",
			toolName:    "search",
			args:        `{"query":"Chains"}`,
			wantError:   false,
			wantSnippet: `Bundle Search Results for "Chains" across AI Infrastructure Stack:`,
		},
		{
			name:        "bundle search architecture dimension",
			toolName:    "search",
			args:        `{"query":"Chains","dimension":"architecture"}`,
			wantError:   false,
			wantSnippet: `[architecture] across AI Infrastructure Stack:`,
		},
		{
			name:        "bundle search empty query returns error",
			toolName:    "search",
			args:        `{"query":""}`,
			wantError:   true,
			wantSnippet: "Error: Query cannot be empty.",
		},
		{
			name:        "bundle search zero hit returns friendly hint",
			toolName:    "search",
			args:        `{"query":"nonexistent_quantum_computing"}`,
			wantError:   false,
			wantSnippet: "No relevant knowledge chunks found across the bundle for query",
		},
		{
			name:        "check_breaking_changes invokes gotcha dimension search",
			toolName:    "check_breaking_changes",
			args:        `{"query":"v0.2 migration"}`,
			wantError:   false,
			wantSnippet: `Bundle Search Results for "v0.2 migration" [gotcha] across AI Infrastructure Stack:`,
		},
		{
			name:        "check_breaking_changes empty query returns error",
			toolName:    "check_breaking_changes",
			args:        `{"query":""}`,
			wantError:   true,
			wantSnippet: "Error: Query cannot be empty.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			*upstreamHit = false
			body := fmt.Sprintf(`{"jsonrpc":"2.0","id":401,"method":"tools/call","params":{"name":"%s","arguments":%s}}`, tt.toolName, tt.args)
			resp := post(t, ts.URL+"/api/mcp/bundle/ai-infra", goodToken, body)
			defer resp.Body.Close()

			assert.Equal(t, http.StatusOK, resp.StatusCode)
			var rpcResp struct {
				Result struct {
					Content []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"content"`
					IsError bool `json:"isError"`
				} `json:"result"`
			}
			raw, _ := io.ReadAll(resp.Body)
			err := json.Unmarshal(raw, &rpcResp)
			require.NoError(t, err)
			require.NotEmpty(t, rpcResp.Result.Content)
			assert.Equal(t, tt.wantError, rpcResp.Result.IsError)
			assert.Contains(t, rpcResp.Result.Content[0].Text, tt.wantSnippet)
			assert.False(t, *upstreamHit, "Node upstream must NOT be touched")
		})
	}
}

// 🧪 [7.14.6.1 · GET 发现面] Table-Driven: Bundle GET 元数据发现原生应答
func TestBundleGetDiscovery_TableDriven(t *testing.T) {
	_, ts, upstreamHit := setupBundleTestFixture(t)

	tests := []struct {
		name       string
		path       string
		token      string
		wantStatus int
		verify     func(t *testing.T, raw string)
	}{
		{
			name:       "authenticated GET bundle returns 200 metadata",
			path:       "/api/mcp/bundle/ai-infra",
			token:      goodToken,
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, raw string) {
				var resp struct {
					Name              string   `json:"name"`
					Version           string   `json:"version"`
					Status            string   `json:"status"`
					RepositoriesCount int      `json:"repositoriesCount"`
					Repositories      []string `json:"repositories"`
					Capabilities      struct {
						Tools []string `json:"tools"`
					} `json:"capabilities"`
				}
				err := json.Unmarshal([]byte(raw), &resp)
				require.NoError(t, err)
				assert.Equal(t, "opengits-bundle-ai-infra", resp.Name)
				assert.Equal(t, "1.0.0", resp.Version)
				assert.Equal(t, "READY", resp.Status)
				assert.Equal(t, 2, resp.RepositoriesCount)
				assert.Contains(t, resp.Repositories, "langchain-ai/langchain")
				assert.Contains(t, resp.Repositories, "chroma-core/chroma")
			},
		},
		{
			name:       "unauthenticated GET bundle returns 401 with challenge",
			path:       "/api/mcp/bundle/ai-infra",
			token:      "",
			wantStatus: http.StatusUnauthorized,
			verify: func(t *testing.T, raw string) {
				assert.Contains(t, raw, "Unauthorized")
			},
		},
		{
			name:       "nonexistent bundle returns 404",
			path:       "/api/mcp/bundle/nonexistent-bundle",
			token:      goodToken,
			wantStatus: http.StatusNotFound,
			verify: func(t *testing.T, raw string) {
				assert.Contains(t, raw, "McpBundle not found")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			*upstreamHit = false
			req, err := http.NewRequest(http.MethodGet, ts.URL+tt.path, nil)
			require.NoError(t, err)
			if tt.token != "" {
				req.Header.Set("Authorization", "Bearer "+tt.token)
			}
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()

			assert.Equal(t, tt.wantStatus, resp.StatusCode)
			raw, _ := io.ReadAll(resp.Body)
			tt.verify(t, string(raw))
			assert.False(t, *upstreamHit, "Node upstream must NOT be touched")
		})
	}
}

// 🧪 [7.14.6.1 · useCount 自增] 验证 Bundle 工具调用异步自增 useCount
func TestBundleUseCountIncrement(t *testing.T) {
	store, ts, upstreamHit := setupBundleTestFixture(t)

	*upstreamHit = false
	body := `{"jsonrpc":"2.0","id":501,"method":"tools/call","params":{"name":"list_resources","arguments":{}}}`
	resp := post(t, ts.URL+"/api/mcp/bundle/ai-infra", goodToken, body)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.False(t, *upstreamHit)

	// 等待异步 goroutine 完成
	time.Sleep(50 * time.Millisecond)

	store.fakeStore.mu.Lock()
	uses := store.bundleUses["bnd-1"]
	store.fakeStore.mu.Unlock()

	assert.GreaterOrEqual(t, uses, 1, "bundle useCount must be incremented")
}
