package mcp

import (
	"context"
	"encoding/json"
	"fmt"
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
				LastReadAt: now,
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

		store.bookshelfRepos["u1"][1].LastReadAt = time.Now()
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
			name: "browse without repository lists Hub bookshelf",
			tool: "browse",
			args: `{}`,
			assertText: func(t *testing.T, text string, isErr bool) {
				assert.False(t, isErr)
				assert.Contains(t, text, "OpenGits Hub Bookshelf")
				assert.Contains(t, text, "octo/kit")
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

func seedManyBookshelfRepos(t *testing.T, store *readFakeStore, count int) {
	t.Helper()
	now := time.Now()
	categories := []string{"AI", "Web", "Systems", "Database"}
	rows := make([]BookshelfRepoRow, 0, count)
	chunks := make([]rawChunkRow, 0, count)
	for i := 0; i < count; i++ {
		id := fmt.Sprintf("repo-bulk-%03d", i)
		owner := fmt.Sprintf("org%d", i%10)
		repoName := fmt.Sprintf("pkg-%03d", i)
		cat := categories[i%len(categories)]
		rows = append(rows, BookshelfRepoRow{
			RepoRow: RepoRow{
				ID: id, Owner: owner, Repo: repoName, Branch: "main", McpStatus: "ACTIVE",
				Category: cat, IsPublic: true,
				RepoProfile: json.RawMessage(`{"description":"General engineering library for services and routing"}`),
				NavTree: json.RawMessage(`[
					{"title":"Chapter 1","summary":"Basics"},
					{"title":"Chapter 2","summary":"Advanced"}
				]`),
			},
			Tags:       []string{cat, "toolkit"},
			LastReadAt: now.Add(-time.Duration(i) * time.Minute),
			UpdatedAt:  now.Add(-time.Duration(i) * time.Hour),
		})
		chunks = append(chunks, rawChunkRow{
			ChunkID:      fmt.Sprintf("chk-bulk-%03d", i),
			DocID:        fmt.Sprintf("doc-bulk-%03d", i),
			RepositoryID: id,
			Owner:        owner,
			Repo:         repoName,
			Heading:      str("Middleware Pipeline"),
			HeadingPath:  str("docs/middleware.md#Middleware Pipeline"),
			Content:      str("Standard middleware pipeline handler and request lifecycle."),
			Title:        str("Middleware Guide"),
			Path:         str("docs/middleware.md"),
		})
	}
	store.bookshelfRepos["u1"] = rows
	store.chunksIndex = chunks
}

func TestHubScaleInvariance(t *testing.T) {
	t.Run("200-repo bookshelf search executes in single O(1) store call", func(t *testing.T) {
		store, ts := setupHubTestFixture(t)
		seedManyBookshelfRepos(t, store, 200)
		store.chunksIndex = append(store.chunksIndex, rawChunkRow{
			ChunkID:      "chk-target-unique",
			DocID:        "doc-target-unique",
			RepositoryID: "repo-bulk-173",
			Owner:        "org3",
			Repo:         "pkg-173",
			Heading:      str("Quantum Router"),
			HeadingPath:  str("docs/quantum.md#Quantum Router"),
			Content:      str("Unique quantum-router-token algorithm for high throughput."),
			Title:        str("Quantum Router"),
			Path:         str("docs/quantum.md"),
		})
		store.searchCallCount = 0

		resp, body := callRead(t, ts, "/api/mcp/hub", "search", `{"query":"quantum-router-token"}`)
		defer resp.Body.Close()
		text, isErr := parseResultText(t, body)
		assert.False(t, isErr)
		assert.Equal(t, 1, store.searchCallCount, "200-repo hub search must invoke SearchChunks exactly once (O(1))")
		assert.Len(t, store.lastSearchReq.RepositoryIDs, 200)
		assert.Contains(t, text, "org3/pkg-173")
		assert.Contains(t, text, "docs/quantum.md")
	})

	t.Run("repo affinity prior boosts matching repository on generic keyword and caps per-repo hits", func(t *testing.T) {
		store, ts := setupHubTestFixture(t)
		seedManyBookshelfRepos(t, store, 20)

		nextRepo := BookshelfRepoRow{
			RepoRow: RepoRow{
				ID: "repo-nextjs", Owner: "vercel", Repo: "next.js", Branch: "main", McpStatus: "ACTIVE",
				Category: "Web", IsPublic: true,
				RepoProfile: json.RawMessage(`{"description":"React Framework","codebaseProfile":{"primaryLanguages":["TypeScript"],"framework":"Next.js"}}`),
			},
			Tags:       []string{"nextjs", "middleware", "react"},
			LastReadAt: time.Now(),
			UpdatedAt:  time.Now(),
		}
		store.bookshelfRepos["u1"] = append(store.bookshelfRepos["u1"], nextRepo)

		for i := 0; i < 5; i++ {
			store.chunksIndex = append(store.chunksIndex, rawChunkRow{
				ChunkID:      fmt.Sprintf("chk-next-%d", i),
				DocID:        fmt.Sprintf("doc-next-%d", i),
				RepositoryID: "repo-nextjs",
				Owner:        "vercel",
				Repo:         "next.js",
				Heading:      str(fmt.Sprintf("Middleware Pattern %d", i)),
				HeadingPath:  str(fmt.Sprintf("docs/mw-%d.md#Middleware", i)),
				Content:      str("Next.js middleware runs before a request is completed."),
				Title:        str("Middleware Guide"),
				Path:         str(fmt.Sprintf("docs/mw-%d.md", i)),
			})
		}

		resp, body := callRead(t, ts, "/api/mcp/hub", "search", `{"query":"nextjs middleware"}`)
		defer resp.Body.Close()
		text, isErr := parseResultText(t, body)
		assert.False(t, isErr)
		assert.Contains(t, text, "--- Result 1")

		firstResultEnd := strings.Index(text, "--- Result 2")
		if firstResultEnd > 0 {
			assert.Contains(t, text[:firstResultEnd], "[Source: vercel/next.js]")
		}

		assert.LessOrEqual(t, strings.Count(text, "[Source: vercel/next.js]"), hubSearchMaxHitsPerRepo)
	})

	t.Run("hub://overview adapts across 10, 50, and 250 repos within bounded size", func(t *testing.T) {
		tests := []struct {
			name      string
			repoCount int
			assertFn  func(t *testing.T, text string)
		}{
			{
				name:      "10 repos full mode",
				repoCount: 10,
				assertFn: func(t *testing.T, text string) {
					assert.Contains(t, text, "Total Tutorials on Hub: 10")
					assert.Contains(t, text, "Teaching Chapters")
				},
			},
			{
				name:      "50 repos compact mode",
				repoCount: 50,
				assertFn: func(t *testing.T, text string) {
					assert.Contains(t, text, "Total Tutorials on Hub: 50")
					assert.NotContains(t, text, "Teaching Chapters")
					assert.Contains(t, text, "Compact mode")
					assert.Contains(t, text, "## AI (")
					assert.Less(t, len(text), 16000)
				},
			},
			{
				name:      "250 repos summary mode",
				repoCount: 250,
				assertFn: func(t *testing.T, text string) {
					assert.Contains(t, text, "Total Tutorials on Hub: 250")
					assert.NotContains(t, text, "Teaching Chapters")
					assert.Contains(t, text, "## Categories")
					assert.Contains(t, text, "Recently Active Tutorials (Top 20)")
					assert.Contains(t, text, "Use search(query=...)")
					assert.Less(t, len(text), 12000)
				},
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				hubOverviewCache = newTTLCache(60*time.Second, 256)
				store, ts := setupHubTestFixture(t)
				seedManyBookshelfRepos(t, store, tt.repoCount)
				resp, body := callHubResource(t, ts, "/api/mcp/hub", "hub://overview")
				defer resp.Body.Close()
				text, isErr := parseResourceText(t, body)
				assert.False(t, isErr)
				tt.assertFn(t, text)
			})
		}
	})

	t.Run("list_resources caps output cleanly on 250-repo bookshelf", func(t *testing.T) {
		store, ts := setupHubTestFixture(t)
		seedManyBookshelfRepos(t, store, 250)

		resp, body := callRead(t, ts, "/api/mcp/hub", "list_resources", `{}`)
		defer resp.Body.Close()
		text, isErr := parseResultText(t, body)
		assert.False(t, isErr)
		assert.Contains(t, text, "250 tutorials found")
		assert.Contains(t, text, "Showing 60 of 250 tutorials")
		assert.Less(t, len(text), 16000)
	})
}

func TestFourPrimitiveConsolidationAndSoftDeprecation(t *testing.T) {
	t.Run("advertised tool lists expose strictly 4 primitives and exclude offlined tools", func(t *testing.T) {
		wantNames := []string{"browse", "search", "read", "read_code"}
		assert.Equal(t, wantNames, NativeAllToolNames)

		for label, list := range map[string][]ToolDefinition{
			"single": NativeToolsList,
			"hub":    NativeHubToolsList,
			"bundle": NativeBundleToolsList,
		} {
			got := make([]string, len(list))
			for i, td := range list {
				got[i] = td.Name
			}
			assert.Equal(t, wantNames, got, "mismatch on %s", label)
		}

		for _, offlined := range []string{"list_chapter_versions", "dissect_code", "verify_claim"} {
			_, inCanon := toolCanonicalName[offlined]
			assert.False(t, inCanon, "offlined tool %s must not be in toolCanonicalName", offlined)
		}
	})

	store, ts := setupHubTestFixture(t)
	store.docContent["doc-1"] = str("# Kit Overview\n\nWelcome to Kit framework")
	store.conceptRich = []ConceptRichNode{
		{ID: "c1", ConceptName: "Router", Category: "architecture", DocumentPath: str("README.md")},
	}

	tests := []struct {
		name     string
		route    string
		toolName string
		args     string
		wantErr  bool
		contains []string
	}{
		{
			name:     "canonical browse on Hub without repository lists tutorials",
			route:    "/api/mcp/hub",
			toolName: "browse",
			args:     `{}`,
			contains: []string{"OpenGits Hub Bookshelf", "octo/kit"},
		},
		{
			name:     "canonical browse on Hub with repository returns repo outline",
			route:    "/api/mcp/hub",
			toolName: "browse",
			args:     `{"repository":"octo/kit"}`,
			contains: []string{"README.md", "components.md"},
		},
		{
			name:     "canonical search(filter=gotchas) runs breaking changes fanout",
			route:    "/api/mcp/hub",
			toolName: "search",
			args:     `{"query":"migration","filter":"gotchas"}`,
			contains: []string{"acme/db", "migration.md"},
		},
		{
			name:     "canonical read with target reads document",
			route:    "/api/mcp/hub",
			toolName: "read",
			args:     `{"repository":"octo/kit","target":"README.md"}`,
			contains: []string{"Kit Overview", "Welcome to Kit framework"},
		},
		{
			name:     "canonical read with concept explores knowledge graph",
			route:    "/api/mcp/hub",
			toolName: "read",
			args:     `{"repository":"octo/kit","concept":"Router","action":"details"}`,
			contains: []string{"Router"},
		},
		{
			name:     "canonical read_code without symbol or path returns guidance error",
			route:    "/api/mcp/octo/kit",
			toolName: "read_code",
			args:     `{}`,
			wantErr:  true,
			contains: []string{`search(filter="symbols")`},
		},
		{
			name:     "soft-deprecated list_resources routes to browse",
			route:    "/api/mcp/octo/kit",
			toolName: "list_resources",
			args:     `{}`,
			contains: []string{"Repository: octo/kit"},
		},
		{
			name:     "soft-deprecated check_breaking_changes routes to search(filter=gotchas)",
			route:    "/api/mcp/hub",
			toolName: "check_breaking_changes",
			args:     `{"query":"migration"}`,
			contains: []string{"acme/db", "migration.md"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, body := callRead(t, ts, tt.route, tt.toolName, tt.args)
			defer resp.Body.Close()
			text, isErr := parseResultText(t, body)
			assert.Equal(t, tt.wantErr, isErr, "body: %s", text)
			for _, sub := range tt.contains {
				assert.Contains(t, text, sub)
			}
		})
	}
}
