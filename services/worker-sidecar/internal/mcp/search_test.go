package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildTsQuery(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "basic two words", in: "hello world", want: "hello:* & world:*"},
		{name: "symbols stripped and separated", in: "foo&bar!baz", want: "foo:* & bar:* & baz:*"},
		{name: "pure underscores dropped", in: "___", want: ""},
		{name: "empty whitespace dropped", in: "   ", want: ""},
		{name: "cjk words separated", in: "上下文 设计", want: "上下文:* & 设计:*"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildTsQuery(tt.in)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestSearchOwnerUserIdIsolation(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)

	sharedHeading := "Deployment Guide"
	sharedContent := "Public deployment instructions for all users"
	privateHeading := "User Secret Deployment"
	privateContent := "Secret deployment keys and credentials for user u1"

	store.chunksIndex = []rawChunkRow{
		{
			ChunkID:     "c-shared",
			DocID:       "doc-shared",
			Heading:     &sharedHeading,
			Content:     &sharedContent,
			Title:       str("Getting Started"),
			Path:        str("README.md"),
			OwnerUserID: nil,
		},
		{
			ChunkID:     "c-private-u1",
			DocID:       "doc-private-u1",
			Heading:     &privateHeading,
			Content:     &privateContent,
			Title:       str("Secret Setup"),
			Path:        str("secret.md"),
			OwnerUserID: str("u1"),
		},
	}

	svc := &readService{store: store}
	resolved := store.resolved["octo/kit"]
	require.NotNil(t, resolved)

	tests := []struct {
		name          string
		userID        string
		wantUserPtr   bool
		expectedID    string
		expectShared  bool
		expectPrivate bool
	}{
		{
			name:          "authenticated user u1 permits shared and own private copy",
			userID:        "u1",
			wantUserPtr:   true,
			expectedID:    "u1",
			expectShared:  true,
			expectPrivate: true,
		},
		{
			name:          "anonymous / unauthenticated query strictly isolates to shared documents",
			userID:        "",
			wantUserPtr:   false,
			expectedID:    "",
			expectShared:  true,
			expectPrivate: false,
		},
		{
			name:          "different user u2 cannot access u1 private copy",
			userID:        "u2",
			wantUserPtr:   true,
			expectedID:    "u2",
			expectShared:  true,
			expectPrivate: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			query := "deployment"
			res := svc.runSearch(context.Background(), resolved, tt.userID, "test-client", searchCallArgs{
				Query: &query,
			})
			require.False(t, res.IsError)

			store.mu.Lock()
			lastReq := store.lastSearchReq
			store.mu.Unlock()

			if tt.wantUserPtr {
				require.NotNil(t, lastReq.UserID)
				assert.Equal(t, tt.expectedID, *lastReq.UserID)
			} else {
				assert.Nil(t, lastReq.UserID)
			}

			if tt.expectPrivate {
				assert.Contains(t, res.Text, "Secret Setup")
			} else {
				assert.NotContains(t, res.Text, "Secret Setup")
			}
			if tt.expectShared {
				assert.Contains(t, res.Text, "README.md")
			}
		})
	}
}

func TestGetFtsLanguageConfig(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "empty language defaults to simple", in: "", want: "simple"},
		{name: "zh-CN is simple", in: "zh-CN", want: "simple"},
		{name: "en-US locked to simple (index column is simple)", in: "en-US", want: "simple"},
		{name: "EN uppercase locked to simple", in: "EN", want: "simple"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := getFtsLanguageConfig(tt.in)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestLocatorScoreBoosts(t *testing.T) {
	tests := []struct {
		name       string
		item       ChunkSearchResult
		kws        []string
		query      string
		assertFunc func(t *testing.T, score float64)
	}{
		{
			name:  "heading raw-query hit boosts over base",
			item:  ChunkSearchResult{Similarity: 0.5, Title: "Other Guide", Heading: str("deploy steps"), Content: "x"},
			kws:   []string{"deploy"},
			query: "deploy",
			assertFunc: func(t *testing.T, score float64) {
				baseScore := locatorScore(ChunkSearchResult{Similarity: 0.5, Title: "Other Guide", Heading: str("Overview"), Content: "deploy the app"}, []string{"deploy"}, "deploy")
				assert.Greater(t, score, baseScore, "heading raw-query hit must boost")
			},
		},
		{
			name:  "content hit boost",
			item:  ChunkSearchResult{Similarity: 0.5, Title: "Other", Heading: str("Intro"), Content: "how to deploy things"},
			kws:   []string{"deploy"},
			query: "deploy",
			assertFunc: func(t *testing.T, score float64) {
				assert.Greater(t, score, 0.5+0.15-0.001, "content hit boost wrong")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			score := locatorScore(tt.item, tt.kws, tt.query)
			tt.assertFunc(t, score)
		})
	}
}

func TestBuildLocatorSnippet(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		keywords []string
		verify   func(t *testing.T, snippet string)
	}{
		{
			name:     "keyword hit wrapped in ellipsis",
			content:  strings.Repeat("a", 300) + " needle here " + strings.Repeat("b", 300),
			keywords: []string{"needle"},
			verify: func(t *testing.T, snippet string) {
				assert.Contains(t, snippet, "needle")
				assert.True(t, strings.HasPrefix(snippet, "..."))
				assert.True(t, strings.HasSuffix(snippet, "..."))
			},
		},
		{
			name:     "no keyword hit returns start window",
			content:  "short content",
			keywords: []string{"zzz"},
			verify: func(t *testing.T, snippet string) {
				assert.Equal(t, "short content", snippet)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			snip := buildLocatorSnippet(tt.content, tt.keywords)
			tt.verify(t, snip)
		})
	}
}

func TestSummarizeDocChunkCodeBlocks(t *testing.T) {
	content := strings.Repeat("narrative ", 30) + "\n```js\nconst a = 1;\n```\nmore narrative here"
	sum := summarizeDocChunk(content)
	assert.Contains(t, sum, "**Key Code Sample:**")
	assert.Contains(t, sum, "const a = 1;")
	assert.True(t, strings.HasSuffix(sum, "```"))
	assert.Equal(t, 2, strings.Count(sum, "```"))
	assert.Contains(t, sum, "...")
}

func seedSearchChunks(t *testing.T, store *readFakeStore) {
	t.Helper()
	store.chunksIndex = []rawChunkRow{
		{ChunkID: "c1", DocID: "doc-1", Heading: str("Deployment"), HeadingPath: str("README.md#Deployment"), Content: str("how to deploy the service with zero downtime"), Title: str("Getting Started"), Path: str("README.md")},
		{ChunkID: "c2", DocID: "doc-2", Heading: str("Config"), HeadingPath: str("docs/guide.md#Config"), Content: str("configuration reference for deployment options"), Title: str("Guide"), Path: str("docs/guide.md")},
	}
}

func TestNativeSearchLocatorTemplate(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedSearchChunks(t, store)
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "search", `{"query":"deploy"}`)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	text, isError := parseResultText(t, body)
	require.False(t, isError, "unexpected isError: %s", text)

	assert.True(t, strings.HasPrefix(text, "Search Results for \"deploy\" across octo/kit [Locator Mode]\n\n"))
	assert.Contains(t, text, "--- Result 1 (Score: ")
	assert.Contains(t, text, "Snippet: ")
	assert.True(t, strings.HasSuffix(text, `(Use read with "target" set to an Address above to fetch the complete section, or pass a document path for the whole page.)`))
}

func TestNativeSearchFullModeTemplate(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedSearchChunks(t, store)
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "search", `{"query":"deploy","detail":"full"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)

	assert.True(t, strings.HasPrefix(text, "Search Results for \"deploy\" across octo/kit:\n\n"))
	assert.Contains(t, text, "Section Heading: Deployment\n")
	assert.Contains(t, text, "Web Link: /docs/octo/kit/README\n")
	assert.Contains(t, text, "how to deploy the service")
}

func TestNativeSearchSummaryMode(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	long := strings.Repeat("narrative text here ", 20) + "\n```js\nconst deploy = true;\n```"
	store.chunksIndex = []rawChunkRow{
		{ChunkID: "c1", DocID: "doc-1", Heading: str("Deployment"), Content: str(long), Title: str("Getting Started"), Path: str("README.md")},
	}
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "search", `{"query":"deploy","detail":"summary"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.Contains(t, text, "[Summary Mode]")
	assert.Contains(t, text, "**Key Code Sample:**")
}

func TestNativeSearchZeroHitWithNoteBlock(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "search", `{"query":"zzznothing"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.True(t, strings.HasPrefix(text, `No relevant documentation chunks found for query: "zzznothing" in octo/kit. Try listing documents or checking the overview.`))
	assert.NotContains(t, text, "untrusted-user-notes")
}

func TestNativeSearchConceptEnrichmentInjection(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedSearchChunks(t, store)
	store.conceptRich = []ConceptRichNode{
		{ID: "cc1", ConceptName: "deploy", Category: "workflow", Summary: str("about deploy"), AuthorReflections: str("line one\nline two"), SopSteps: []string{"step a", "step b"}, DocumentPath: str("README.md"), HeadingPath: str("README.md#deploy")},
	}
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "search", `{"query":"deploy"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.Contains(t, text, "🧠 导师设计思考与原理卡片 (Author Reflections & Principles)")
	assert.Contains(t, text, "- **作者思考与 Trade-off 权衡**:\n  > line one\n  > line two\n")
	assert.Contains(t, text, "  1. step a\n  2. step b\n")
	assert.Contains(t, text, "- **来源**: README.md [Address: README.md#deploy]")
	assert.Contains(t, text, `for the full concept package`)
}

func TestNativeSearchDependencyHintInjection(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedSearchChunks(t, store)
	store.conceptRich = []ConceptRichNode{
		{ID: "cc1", ConceptName: "deploy", Category: "workflow", DocumentPath: str("README.md")},
	}
	store.memberIDs["cc1"] = []string{"cc1"}
	store.depEdges = []EdgeRef{
		{SourceID: "p1", TargetID: "cc1", Type: "prerequisite", Weight: 0.9, Source: "curriculum_order"},
	}
	store.nodesByID["p1"] = ConceptNodeLite{ID: "p1", ConceptName: "基础概念", Category: "principle", DocumentPath: str("README.md")}
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "search", `{"query":"deploy"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.Contains(t, text, "⚡ 依赖提示 (Prerequisite Hint)")
	assert.Contains(t, text, "- 理解「deploy」建议先掌握:")
	assert.Contains(t, text, "• 基础概念 (principle) [来源:教学顺序(确定) · w0.90]")
	assert.Contains(t, text, "(可用 read 精读任一前置概念，或 explore_concept(action=\"path\") 获取完整递进链)")
	assert.Contains(t, text, "(证据来源：共现/教学顺序/代码依赖=确定；LLM推断=可能幻觉)")
}

func TestNativeSearchRSGGrounding(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedSearchChunks(t, store)
	store.conceptRich = []ConceptRichNode{
		{ID: "cc1", ConceptName: "deploy", Category: "workflow"},
	}

	dir := t.TempDir()
	t.Setenv("STORAGE_ROOT", filepath.ToSlash(dir))
	sha := strings.Repeat("a", 40)
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "octo", "kit"), 0o755))

	artifact := map[string]any{
		"nodes": []map[string]any{
			{"path": "src/deploy.ts", "role": "core_contract", "pageRank": 0.9, "isBackbone": true},
			{"path": "src/util.ts", "role": "helper", "pageRank": 0.1, "isBackbone": false},
		},
		"goldenSymbols": []map[string]any{
			{"name": "deployAll", "kind": "function", "file": "src/deploy.ts", "score": 0.87},
			{"name": "util", "kind": "function", "file": "src/util.ts", "score": 0.5},
		},
	}
	data, err := json.Marshal(artifact)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "octo", "kit", sha+".json"), data, 0o644))
	store.repoGitSha.owner, store.repoGitSha.repo, store.repoGitSha.sha, store.repoGitSha.ok = "octo", "kit", sha, true

	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "search", `{"query":"deploy"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)

	assert.Contains(t, text, "- **核心代码符号 (AST Golden Symbols)**:")
	assert.Contains(t, text, "- `deployAll` (function) in `src/deploy.ts` [PR: 0.87]")
	assert.NotContains(t, text, "`util`", "non-backbone symbol must be filtered")
	assert.Contains(t, text, "- **主干实现文件**:")
	assert.Contains(t, text, "- `src/deploy.ts` (core_contract)")
}

func TestNativeBreakingChangesTemplates(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)

	store.chunksIndex = []rawChunkRow{
		{ChunkID: "c1", DocID: "doc-1", Heading: str("v2 Breaking"), HeadingPath: str("README.md#v2"), Content: str("the breaking change migration guide"), Title: str("Getting Started"), Path: str("README.md")},
	}
	ts := readTestServer(t, store, nil)

	t.Run("locator mode default", func(t *testing.T) {
		resp, body := callRead(t, ts, "/api/mcp/octo/kit", "check_breaking_changes", `{"query":"v2"}`)
		defer resp.Body.Close()
		text, _ := parseResultText(t, body)
		assert.True(t, strings.HasPrefix(text, "Breaking Changes Locator for \"v2\" in octo/kit\n\n"))
	})

	t.Run("full mode", func(t *testing.T) {
		resp2, body2 := callRead(t, ts, "/api/mcp/octo/kit", "breaking_changes", `{"query":"v2","detail":"full"}`)
		defer resp2.Body.Close()
		text2, _ := parseResultText(t, body2)
		assert.True(t, strings.HasPrefix(text2, "🚨 Breaking Changes in octo/kit:\n\n"))
		assert.Contains(t, text2, "### v2 Breaking\nPath: README.md\n")
		assert.Contains(t, text2, "the breaking change migration guide")
	})

	t.Run("zero hits message", func(t *testing.T) {
		store2 := newReadFakeStore()
		seedAuth(t, store2)
		ts2 := readTestServer(t, store2, nil)
		resp3, body3 := callRead(t, ts2, "/api/mcp/octo/kit", "check_breaking_changes", `{"query":"nothing"}`)
		defer resp3.Body.Close()
		text3, _ := parseResultText(t, body3)
		assert.Equal(t, `No explicit breaking changes found for "nothing" in octo/kit.`, text3)
	})
}

func TestNativeSearchCodeFallbackOnZeroHits(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.chunksIndex = []rawChunkRow{
		{ChunkID: "c1", DocID: "doc-1", Heading: str("Deploy"), Content: str("prose about deployment"), Title: str("Doc"), Path: str("README.md")},
	}
	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "search", `{"query":"deploy","filter":"code"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.Contains(t, text, "Code Examples & Implementation Results")
}

func TestSearchAliasAndModeRewrite(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedSearchChunks(t, store)
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "search_docs", `{"query":"deploy","mode":"all"}`)
	defer resp.Body.Close()
	text, isError := parseResultText(t, body)
	require.False(t, isError)
	assert.True(t, strings.HasPrefix(text, `Search Results for "deploy"`))
}

func TestSearchDisabledPolicyFallsBackToProxy(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedSearchChunks(t, store)
	store.policies["search"] = ToolPolicy{IsEnabled: false, TokenBudget: 4000, TierRequirement: "FREE"}
	upstreamHit := false
	ts := readTestServer(t, store, &upstreamHit)

	resp, _ := callRead(t, ts, "/api/mcp/octo/kit", "search", `{"query":"deploy"}`)
	defer resp.Body.Close()
	assert.True(t, upstreamHit, "disabled search policy must fall back to proxy")
}

func TestLoadRSGArtifact_LRUCache(t *testing.T) {
	tmpRoot := t.TempDir()
	t.Setenv("STORAGE_ROOT", tmpRoot)

	owner, repo, sha := "acme", "calc", "sha-lru-1"
	dir := filepath.Join(tmpRoot, owner, repo)
	require.NoError(t, os.MkdirAll(dir, 0755))

	artifactJSON := `{
		"nodes": [{"path": "src/main.go", "role": "entry_point", "pageRank": 1.0, "isBackbone": true}],
		"goldenSymbols": [{"name": "Main", "kind": "function", "file": "src/main.go", "score": 0.95}]
	}`
	filePath := filepath.Join(dir, sha+".json")
	require.NoError(t, os.WriteFile(filePath, []byte(artifactJSON), 0644))

	a1 := loadRSGArtifact(owner, repo, sha)
	require.NotNil(t, a1)
	assert.Len(t, a1.Nodes, 1)
	assert.Equal(t, "src/main.go", a1.Nodes[0].Path)
	assert.Equal(t, "Main", a1.GoldenSymbols[0].Name)

	a2 := loadRSGArtifact(owner, repo, sha)
	require.NotNil(t, a2)
	assert.Same(t, a1, a2, "LRU cache hit must return identical pointer without re-parsing")

	time.Sleep(20 * time.Millisecond)
	updatedJSON := `{
		"nodes": [{"path": "src/new.go", "role": "entry_point", "pageRank": 1.0, "isBackbone": true}],
		"goldenSymbols": []
	}`
	require.NoError(t, os.WriteFile(filePath, []byte(updatedJSON), 0644))

	a3 := loadRSGArtifact(owner, repo, sha)
	require.NotNil(t, a3)
	assert.NotSame(t, a1, a3, "modified file must invalidate cache and re-parse")
	assert.Equal(t, "src/new.go", a3.Nodes[0].Path)

	assert.Nil(t, loadRSGArtifact(owner, repo, "nonexistent-sha"))
}

func timeNowUTC() time.Time { return time.Now().UTC() }
