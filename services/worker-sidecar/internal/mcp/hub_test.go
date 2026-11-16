package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupHubTestFixture(t *testing.T) (*readFakeStore, *httptest.Server) {
	t.Helper()
	store := newReadFakeStore()
	seedAuth(t, store)

	now := time.Now()
	// Repo 1: octo/kit (Framework)
	kitRepo := &ResolvedRepo{
		Repository: RepoRow{
			ID: "repo-kit", Owner: "octo", Repo: "kit", Branch: "main", McpStatus: "ACTIVE",
			Category: "Framework", IsPublic: true, Edition: "",
			RepoProfile: json.RawMessage(`{"description":"Modern UI Toolkit"}`),
		},
		Documents: []DocMeta{
			{ID: "doc-kit-1", Path: "README.md", Title: "Kit Overview"},
			{ID: "doc-kit-2", Path: "docs/components.md", Title: "Components Guide"},
		},
	}
	// Repo 2: acme/db (Database, v2 edition)
	dbRepo := &ResolvedRepo{
		Repository: RepoRow{
			ID: "repo-db", Owner: "acme", Repo: "db", Branch: "main", McpStatus: "ACTIVE",
			Category: "Database", IsPublic: true, Edition: "v2",
			RepoProfile: json.RawMessage(`{"description":"High performance database"}`),
		},
		Documents: []DocMeta{
			{ID: "doc-db-1", Path: "README.md", Title: "DB Quickstart"},
			{ID: "doc-db-2", Path: "docs/migration.md", Title: "v2 Migration Breaking Changes"},
		},
	}

	store.bookshelfResolved["u1|octo/kit"] = kitRepo
	store.bookshelfResolved["u1|acme/db"] = dbRepo
	store.bookshelfResolved["u1|acme/db@v2"] = dbRepo

	store.bookshelfRepos["u1"] = []BookshelfRepoRow{
		{
			RepoRow:    kitRepo.Repository,
			LastReadAt: now,
			UpdatedAt:  now,
		},
		{
			RepoRow:   dbRepo.Repository,
			UpdatedAt: now,
		},
	}

	store.docContent["doc-kit-1"] = str("# Kit Overview\n\nWelcome to Kit framework.")
	store.docContent["doc-kit-2"] = str("# Components Guide\n\nButton, Modal, and Card components.")
	store.docContent["doc-db-1"] = str("# DB Quickstart\n\nSetup DB cluster easily.")
	store.docContent["doc-db-2"] = str("# Migration\n\n## Breaking Changes in v2\nDrop legacy v1 connection pool API.")

	store.chunks["doc-kit-1"] = []Chunk{
		{Heading: str("Kit Overview"), Content: "Welcome to Kit framework."},
	}
	store.chunks["doc-db-1"] = []Chunk{
		{Heading: str("DB Quickstart"), Content: "Setup DB cluster easily."},
	}
	store.chunks["doc-db-2"] = []Chunk{
		{Heading: str("Breaking Changes in v2"), Content: "Drop legacy v1 connection pool API."},
	}

	store.chunksIndex = []rawChunkRow{
		{
			ChunkID: "chk-kit-1", DocID: "doc-kit-1", Heading: str("Kit Overview"),
			HeadingPath: str("README.md#Kit Overview"), Content: str("Welcome to Kit framework."),
			Title: str("Kit Overview"), Path: str("README.md"),
		},
		{
			ChunkID: "chk-kit-2", DocID: "doc-kit-2", Heading: str("Components Guide"),
			HeadingPath: str("docs/components.md#Components"), Content: str("Button, Modal, and Card components."),
			Title: str("Components Guide"), Path: str("docs/components.md"),
		},
		{
			ChunkID: "chk-db-1", DocID: "doc-db-1", Heading: str("DB Quickstart"),
			HeadingPath: str("README.md#DB Quickstart"), Content: str("Setup DB cluster easily."),
			Title: str("DB Quickstart"), Path: str("README.md"),
		},
		{
			ChunkID: "chk-db-2", DocID: "doc-db-2", Heading: str("Breaking Changes in v2"),
			HeadingPath: str("docs/migration.md#Breaking Changes in v2"), Content: str("Drop legacy v1 connection pool API in v2 migration."),
			Title: str("v2 Migration Breaking Changes"), Path: str("docs/migration.md"),
		},
	}

	ts := readTestServer(t, store, nil)
	return store, ts
}

func callHubResource(t *testing.T, ts *httptest.Server, path, uri string) (*http.Response, string) {
	t.Helper()
	body := `{"jsonrpc":"2.0","id":10,"method":"resources/read","params":{"uri":"` + uri + `"}}`
	req, _ := http.NewRequest(http.MethodPost, ts.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+goodToken)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	return resp, readAll(t, resp.Body)
}

func parseResourceText(t *testing.T, body string) (text string, isError bool) {
	t.Helper()
	var parsed struct {
		Result struct {
			Contents []struct {
				URI  string `json:"uri"`
				Text string `json:"text"`
			} `json:"contents"`
		} `json:"result"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	err := json.Unmarshal([]byte(body), &parsed)
	require.NoError(t, err, "invalid JSON-RPC resource response:\n%s", body)
	if parsed.Error != nil {
		return parsed.Error.Message, true
	}
	require.NotEmpty(t, parsed.Result.Contents, "empty resource contents in %s", body)
	return parsed.Result.Contents[0].Text, false
}

// 🧪 Hub Capability Manifest availableTools 派生自 NativeAllToolNames（与 TS 契约锁步）
func TestHubManifestsAvailableTools(t *testing.T) {
	store, _ := setupHubTestFixture(t)
	svc := &readService{store: store}
	manifests := svc.buildHubManifests(context.Background(), "u1")
	require.NotEmpty(t, manifests)
	for _, m := range manifests {
		endpoint, ok := m["mcpEndpoint"].(map[string]any)
		require.True(t, ok)
		tools, ok := endpoint["availableTools"].([]string)
		require.True(t, ok)
		assert.Equal(t, NativeAllToolNames, tools)
	}
}

// ── 1. Hub Overview 资源读取 ──

// 🧪 [7.14.4.1] 协议握手：Hub 协议发现原生承接 (resources/read)
func TestHubOverviewResource(t *testing.T) {
	_, ts := setupHubTestFixture(t)

	tests := []struct {
		name        string
		uri         string
		expectError bool
		assertText  func(t *testing.T, text string)
	}{
		{
			name:        "valid hub overview resource",
			uri:         "hub://overview",
			expectError: false,
			assertText: func(t *testing.T, text string) {
				assert.Contains(t, text, "OpenGits Hub Capability Manifest Overview")
				assert.Contains(t, text, "octo/kit")
				assert.Contains(t, text, "acme/db")
				assert.Contains(t, text, "Framework")
				assert.Contains(t, text, "Database")
			},
		},
		{
			name:        "unknown resource uri",
			uri:         "hub://unknown-resource",
			expectError: true,
			assertText: func(t *testing.T, text string) {
				assert.Contains(t, text, "Resource not found")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, body := callHubResource(t, ts, "/api/mcp/hub", tt.uri)
			defer resp.Body.Close()
			text, isErr := parseResourceText(t, body)
			assert.Equal(t, tt.expectError, isErr)
			tt.assertText(t, text)
		})
	}
}

// ── 2. Hub list_resources 书架检索 ──

func TestHubListResources(t *testing.T) {
	store, ts := setupHubTestFixture(t)

	tests := []struct {
		name       string
		args       string
		setupStore func(s *readFakeStore)
		assertText func(t *testing.T, text string, isErr bool)
	}{
		{
			name: "list all bookshelf repos",
			args: `{}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "OpenGits Hub Bookshelf")
				assert.Contains(t, text, "octo/kit")
				assert.Contains(t, text, "acme/db")
				assert.Contains(t, text, "Framework")
				assert.Contains(t, text, "Database")
			},
		},
		{
			name: "filter by category",
			args: `{"category":"Database"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "acme/db")
				assert.NotContains(t, text, "octo/kit")
			},
		},
		{
			name: "filter by query keyword",
			args: `{"query":"Toolkit"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "octo/kit")
				assert.NotContains(t, text, "acme/db")
			},
		},
		{
			name: "empty bookshelf returns guidance",
			args: `{}`,
			setupStore: func(s *readFakeStore) {
				s.bookshelfRepos["u1"] = nil
			},
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "0 tutorials found")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.setupStore != nil {
				tt.setupStore(store)
			}
			resp, body := callRead(t, ts, "/api/mcp/hub", "list_resources", tt.args)
			defer resp.Body.Close()
			text, isErr := parseResultText(t, body)
			tt.assertText(t, text, isErr)
		})
	}
}

// ── 3. Hub search 范围限制与跨仓 Fan-out ──

// 🧪 [7.14.3.1] 全局概念：跨仓概念检索同义词归并
func TestHubSearch(t *testing.T) {
	store, ts := setupHubTestFixture(t)

	tests := []struct {
		name       string
		args       string
		setupStore func(s *readFakeStore)
		assertText func(t *testing.T, text string, isErr bool)
	}{
		{
			name: "scoped search into single repo",
			args: `{"repository":"octo/kit","query":"Components"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "Components")
				assert.Contains(t, text, "components.md")
			},
		},
		{
			name: "scoped search repo not found on bookshelf",
			args: `{"repository":"unknown/missing","query":"Components"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.True(t, isErr)
				assert.Contains(t, text, "unknown/missing")
				assert.Contains(t, text, "not found in your OpenGits Hub")
			},
		},
		{
			name: "fan-out search across bookshelf without repository",
			args: `{"query":"cluster"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "cluster")
				assert.Contains(t, text, "acme/db")
			},
		},
		{
			name: "fan-out concept search across bookshelf",
			args: `{"query":"Transaction","filter":"concept"}`,
			setupStore: func(s *readFakeStore) {
				gcID := "gc-tx"
				s.crossConceptHits = []CrossRepoConceptHit{
					{
						ConceptID:       "c-tx",
						ConceptName:     "Transaction",
						Category:        "Database",
						GlobalConceptID: &gcID,
						RepoID:          "repo-db",
						RepoOwner:       "acme",
						RepoName:        "db",
						DocPath:         str("docs/tx.md"),
						HeadingPath:     str("Transactions"),
						Address:         "acme/db#docs/tx.md#Transactions",
					},
				}
				s.globalConcepts["gc-tx"] = GlobalConceptMeta{
					CanonicalName: "Transaction",
					Aliases:       []string{"ACID Tx", "事务"},
				}
			},
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "跨仓概念检索")
				assert.Contains(t, text, "Transaction")
				assert.Contains(t, text, "acme/db")
				assert.Contains(t, text, "ACID Tx")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.setupStore != nil {
				tt.setupStore(store)
			}
			resp, body := callRead(t, ts, "/api/mcp/hub", "search", tt.args)
			defer resp.Body.Close()
			text, isErr := parseResultText(t, body)
			tt.assertText(t, text, isErr)
		})
	}
}

// 🧪 [7.14.2.1] 扇出聚合：跨仓检索并发扇出与 Edition 讲法版本折叠
func TestFoldScopeRowsAndEditionHint(t *testing.T) {
	t.Run("foldScopeRows prioritizes recently read and base edition", func(t *testing.T) {
		now := time.Now()
		rows := []BookshelfRepoRow{
			{
				RepoRow:    RepoRow{ID: "r1", Owner: "octo", Repo: "kit", Branch: "main", Edition: "v1"},
				LastReadAt: now.Add(-2 * time.Hour),
			},
			{
				RepoRow:    RepoRow{ID: "r2", Owner: "octo", Repo: "kit", Branch: "main", Edition: ""},
				LastReadAt: now.Add(-1 * time.Hour),
			},
			{
				RepoRow:    RepoRow{ID: "r3", Owner: "octo", Repo: "kit", Branch: "main", Edition: "v2"},
				LastReadAt: now, // most recently read
			},
		}

		groups := foldScopeRows(rows)
		require.Len(t, groups, 1)
		assert.Equal(t, "octo/kit@main", groups[0].Key)
		assert.Equal(t, "r3", groups[0].Preferred.ID, "most recently read edition must be preferred")
		assert.Len(t, groups[0].Rows, 3)
	})

	t.Run("multi-edition repos inject edition hint in fanout search", func(t *testing.T) {
		store, ts := setupHubTestFixture(t)
		// Add another edition for acme/db so that multiEditionCount > 0
		store.bookshelfRepos["u1"] = append(store.bookshelfRepos["u1"], BookshelfRepoRow{
			RepoRow: RepoRow{
				ID: "repo-db-v1", Owner: "acme", Repo: "db", Branch: "main", McpStatus: "ACTIVE",
				Category: "Database", IsPublic: true, Edition: "v1",
			},
			LastReadAt: time.Now().Add(-10 * time.Hour),
		})

		resp, body := callRead(t, ts, "/api/mcp/hub", "search", `{"query":"cluster"}`)
		defer resp.Body.Close()
		text, isErr := parseResultText(t, body)
		assert.False(t, isErr)
		assert.Contains(t, text, "部分仓库存在多种转录讲法，已按你在读的讲法检索")
	})
}

// ── 4. Hub read / outline 门禁与执行 ──

// 🧪 [7.14.1.1] 门禁隔离：Hub 单仓原语强制 repository 门禁
func TestHubReadAndOutlineGate(t *testing.T) {
	_, ts := setupHubTestFixture(t)

	tests := []struct {
		name       string
		tool       string
		args       string
		assertText func(t *testing.T, text string, isErr bool)
	}{
		{
			name: "read missing repository returns scope required error",
			tool: "read",
			args: `{"target":"README.md"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.True(t, isErr)
				assert.Contains(t, text, "repository")
				assert.Contains(t, text, "required")
			},
		},
		{
			name: "read with repository succeeds",
			tool: "read",
			args: `{"repository":"octo/kit","target":"README.md"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "Kit Overview")
				assert.Contains(t, text, "Welcome to Kit framework")
			},
		},
		{
			name: "read nonexistent repo returns not found",
			tool: "read",
			args: `{"repository":"ghost/repo","target":"README.md"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.True(t, isErr)
				assert.Contains(t, text, "ghost/repo")
			},
		},
		{
			name: "outline missing repository returns scope required error",
			tool: "outline",
			args: `{}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.True(t, isErr)
				assert.Contains(t, text, "repository")
				assert.Contains(t, text, "required")
			},
		},
		{
			name: "outline with repository succeeds",
			tool: "outline",
			args: `{"repository":"octo/kit"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "README.md")
				assert.Contains(t, text, "components.md")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, body := callRead(t, ts, "/api/mcp/hub", tt.tool, tt.args)
			defer resp.Body.Close()
			text, isErr := parseResultText(t, body)
			tt.assertText(t, text, isErr)
		})
	}
}

// ── 5. Hub check_breaking_changes ──

func TestHubBreakingChanges(t *testing.T) {
	_, ts := setupHubTestFixture(t)

	tests := []struct {
		name       string
		args       string
		assertText func(t *testing.T, text string, isErr bool)
	}{
		{
			name: "scoped breaking changes",
			args: `{"repository":"acme/db","query":"migration"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "acme/db")
				assert.Contains(t, text, "migration.md")
			},
		},
		{
			name: "fan-out breaking changes across bookshelf",
			args: `{"query":"migration"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "acme/db")
				assert.Contains(t, text, "migration.md")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, body := callRead(t, ts, "/api/mcp/hub", "check_breaking_changes", tt.args)
			defer resp.Body.Close()
			text, isErr := parseResultText(t, body)
			tt.assertText(t, text, isErr)
		})
	}
}


// ── 7. Hub explore_concept 行为分派 ──

func TestHubExploreConcept(t *testing.T) {
	_, ts := setupHubTestFixture(t)

	tests := []struct {
		name       string
		args       string
		assertText func(t *testing.T, text string, isErr bool)
	}{
		{
			name: "coverage action prompts for concept when empty",
			args: `{"action":"coverage"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "技能覆盖：请指定要检索的技能或概念名称")
			},
		},
		{
			name: "recommend action requires project description in concept",
			args: `{"action":"recommend"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.True(t, isErr)
				assert.Contains(t, text, "pass a short project description")
			},
		},
		{
			name: "details action requires repository",
			args: `{"action":"details","concept":"Button"}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.True(t, isErr)
				assert.Contains(t, text, "repository")
				assert.Contains(t, text, "required")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, body := callRead(t, ts, "/api/mcp/hub", "explore_concept", tt.args)
			defer resp.Body.Close()
			text, isErr := parseResultText(t, body)
			tt.assertText(t, text, isErr)
		})
	}
}
