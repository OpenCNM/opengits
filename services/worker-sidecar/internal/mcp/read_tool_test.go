package mcp

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// readFakeStore 在 Phase 2a fakeStore 基础上补齐 ReadStore 面。
type readFakeStore struct {
	*fakeStore

	repos      map[string]*RepoRow // "owner/repo" → row（default branch）
	savedRepos map[string]bool     // "repoID|userID"
	resolved   map[string]*ResolvedRepo
	docContent map[string]*string          // docID → content
	chunks     map[string][]Chunk          // docID → chunks
	concepts   map[string]*ConceptNodeLite // docID|headingPath → concept
	memberIDs  map[string][]string
	edges      []EdgeRef
	nodesByID  map[string]ConceptNodeLite
	conceptDoc map[string]*string           // conceptID → documentId
	coLocated  map[string][]ConceptNodeLite // documentId → nodes
	policies   map[string]ToolPolicy
	docOwners  map[string]*string           // docID → ownerUserId (nil for shared)

	chunkHeadings  map[string][]ChunkHeading
	docConcepts    map[string][]ConceptNodeLite
	taxonomy       map[string][]TaxonomyNode
	prereqEdges    map[string][]EdgeRef
	prereqEdgesAll []EdgeRef
	chunksIndex    []rawChunkRow
	lastSearchReq  SearchChunksRequest
	conceptRich    []ConceptRichNode
	depEdges       []EdgeRef
	repoGitSha     struct {
		owner, repo, sha string
		ok               bool
	}

	bookshelfRepos    map[string][]BookshelfRepoRow
	bookshelfResolved map[string]*ResolvedRepo
	crossConceptHits  []CrossRepoConceptHit
	globalConcepts    map[string]GlobalConceptMeta
	bundleDocs        map[string]bundleDocTestItem
	activeOutline     *ActiveOutlineInfo

	mu           sync.Mutex
	callLogs     []CallLogEntry
	incRepoCalls []string
}

type bundleDocTestItem struct {
	Title   string
	Path    string
	Content string
}

func newReadFakeStore() *readFakeStore {
	return &readFakeStore{
		fakeStore:  newFakeStore(),
		repos:      map[string]*RepoRow{},
		savedRepos: map[string]bool{},
		resolved:   map[string]*ResolvedRepo{},
		docContent: map[string]*string{},
		docOwners:  map[string]*string{},
		chunks:     map[string][]Chunk{},
		concepts:   map[string]*ConceptNodeLite{},
		memberIDs:  map[string][]string{},
		nodesByID:  map[string]ConceptNodeLite{},
		conceptDoc: map[string]*string{},
		coLocated:  map[string][]ConceptNodeLite{},
		policies:   map[string]ToolPolicy{},

		bookshelfRepos:    map[string][]BookshelfRepoRow{},
		bookshelfResolved: map[string]*ResolvedRepo{},
		globalConcepts:    map[string]GlobalConceptMeta{},
		bundleDocs:        map[string]bundleDocTestItem{},

		chunkHeadings: map[string][]ChunkHeading{},
		docConcepts:   map[string][]ConceptNodeLite{},
		taxonomy:      map[string][]TaxonomyNode{},
		prereqEdges:   map[string][]EdgeRef{},
	}
}

func str(s string) *string { return &s }

func (f *readFakeStore) GetDocumentQuizzesByPath(_ context.Context, _, _ string) ([]ChapterQuizRow, error) {
	return nil, nil
}

func (f *readFakeStore) ConceptEditionCompare(_ context.Context, _, _, _ string) ([]ConceptEditionRow, error) {
	return nil, nil
}

func (f *readFakeStore) FindDefaultBranchRepo(_ context.Context, owner, repo, _ string) (*RepoRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.repos[owner+"/"+repo], nil
}

func (f *readFakeStore) HasSavedRepoAccess(_ context.Context, repositoryID, userID string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.savedRepos[repositoryID+"|"+userID], nil
}

func (f *readFakeStore) ResolveSingleRepo(_ context.Context, owner, repo, _, _, userID string) (*ResolvedRepo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if userID != "" {
		if res, ok := f.resolved[owner+"/"+repo+":"+userID]; ok {
			return res, nil
		}
	}
	return f.resolved[owner+"/"+repo], nil
}

func (f *readFakeStore) FindDocContent(_ context.Context, _, docID, userID string) (*string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if owner, exists := f.docOwners[docID]; exists {
		if owner != nil && (userID == "" || *owner != userID) {
			return nil, nil
		}
	}
	return f.docContent[docID], nil
}

func (f *readFakeStore) ListChunksByDoc(_ context.Context, docID string) ([]Chunk, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.chunks[docID], nil
}

func (f *readFakeStore) FindConceptForDoc(_ context.Context, _, documentID string, headingPath *string) (*ConceptNodeLite, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := documentID + "|"
	if headingPath != nil {
		key += *headingPath
	}
	return f.concepts[key], nil
}

func (f *readFakeStore) CanonicalMemberIDs(_ context.Context, _, nodeID string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if ids, ok := f.memberIDs[nodeID]; ok {
		return ids, nil
	}
	return []string{nodeID}, nil
}

func (f *readFakeStore) EdgesTouching(_ context.Context, _ string, _ []string) ([]EdgeRef, error) {
	return f.edges, nil
}

func (f *readFakeStore) NodesByIDs(_ context.Context, _ string, ids []string) ([]ConceptNodeLite, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []ConceptNodeLite
	for _, id := range ids {
		if n, ok := f.nodesByID[id]; ok {
			out = append(out, n)
		}
	}
	return out, nil
}

func (f *readFakeStore) CoLocatedNodes(_ context.Context, _, documentID string, _ []string, _ int) ([]ConceptNodeLite, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.coLocated[documentID], nil
}

func (f *readFakeStore) GetConceptDocumentID(_ context.Context, _, nodeID string) (*string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.conceptDoc[nodeID], nil
}

func (f *readFakeStore) ToolPolicyMap(_ context.Context) (map[string]ToolPolicy, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.policies, nil
}

// InsertCallLog 镜像真实 pgxStore 批量写语义：调用日志入队记录 +
// 仓库计数由条目聚合（真实侧由 telemetryBatcher flush 派生，测试替身同步派生）。
func (f *readFakeStore) InsertCallLog(_ context.Context, e CallLogEntry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.callLogs = append(f.callLogs, e)
	if e.RepositoryID != "" {
		f.incRepoCalls = append(f.incRepoCalls, e.RepositoryID)
	}
	return nil
}

func (f *readFakeStore) IncrementRepoCalls(_ context.Context, repositoryID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.incRepoCalls = append(f.incRepoCalls, repositoryID)
	return nil
}

func (f *readFakeStore) ListUserBookshelfRepos(_ context.Context, userID string) ([]BookshelfRepoRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bookshelfRepos[userID], nil
}

func (f *readFakeStore) ResolveBookshelfRepo(_ context.Context, userID, ref, edition string) (*ResolvedRepo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	base, refEd := parseHubRef(ref)
	effEd := edition
	if effEd == "" {
		effEd = refEd
	}
	key := userID + "|" + base
	if effEd != "" {
		key += "@" + effEd
	}
	if r, ok := f.bookshelfResolved[key]; ok {
		return r, nil
	}
	return f.bookshelfResolved[userID+"|"+base], nil
}

func (f *readFakeStore) FindConceptAcrossBookshelf(_ context.Context, _ string, _ string, _ int) ([]CrossRepoConceptHit, map[string]GlobalConceptMeta, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.crossConceptHits, f.globalConcepts, nil
}

func (f *readFakeStore) FindBundleDoc(_ context.Context, repositoryID, path string) (string, string, string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := repositoryID + "|" + strings.ToLower(path)
	if item, ok := f.bundleDocs[key]; ok {
		return item.Title, item.Path, item.Content, true, nil
	}
	if item, ok := f.bundleDocs[repositoryID+"|"+strings.ToLower(path)+".md"]; ok {
		return item.Title, item.Path, item.Content, true, nil
	}
	if item, ok := f.bundleDocs[repositoryID+"|"+strings.ToLower(path)+".mdx"]; ok {
		return item.Title, item.Path, item.Content, true, nil
	}
	for _, res := range f.resolved {
		if res.Repository.ID == repositoryID {
			for _, d := range res.Documents {
				if strings.EqualFold(d.Path, path) || strings.EqualFold(d.Path, path+".md") || strings.EqualFold(d.Path, path+".mdx") {
					if c, ok := f.docContent[d.ID]; ok && c != nil {
						return d.Title, d.Path, *c, true, nil
					}
				}
			}
		}
	}
	return "", "", "", false, nil
}

func (f *readFakeStore) GetActiveOutline(_ context.Context, _ string) (*ActiveOutlineInfo, error) {
	if f.activeOutline != nil {
		return f.activeOutline, nil
	}
	return nil, nil
}

func (f *readFakeStore) HasPrivateDocs(_ context.Context, _ string, userID string) bool {
	if userID == "" {
		return false
	}
	for _, owner := range f.docOwners {
		if owner != nil && *owner == userID {
			return true
		}
	}
	return false
}

// ── 测试脚手架 ──

func makeResolvedRepo() *ResolvedRepo {
	return &ResolvedRepo{
		Repository: RepoRow{
			ID: "repo-1", Owner: "octo", Repo: "kit", Branch: "main", McpStatus: "ACTIVE",
			Category: "Framework", IsPublic: true,
		},
		Documents: []DocMeta{
			{ID: "doc-1", Path: "README.md", Title: "Getting Started"},
			{ID: "doc-2", Path: "docs/guide.md", Title: "Guide"},
		},
	}
}

func readTestServer(t *testing.T, store *readFakeStore, upstreamHit *bool) *httptest.Server {
	t.Helper()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if upstreamHit != nil {
			*upstreamHit = true
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"proxied"}]}}`))
	}))
	t.Cleanup(up.Close)
	cfg := Config{
		Addr: "127.0.0.1:0", UpstreamURL: up.URL, InternalToken: "test-internal-token",
		UpstreamSkipHeader: "x-mcp-quota-checked", ProxyTimeoutMs: 2000, PoolMax: 2,
	}
	ts := httptest.NewServer(newServer(cfg, store).routes(http.HandlerFunc(newServer(cfg, store).handleRoot)))
	t.Cleanup(ts.Close)
	return ts
}

func seedAuth(t *testing.T, store *readFakeStore) {
	t.Helper()
	store.tokens[sha256Hex(goodToken)] = &TokenRecord{TokenID: "t1", UserID: "u1"}
	store.resolved["octo/kit"] = makeResolvedRepo()
	store.repos["octo/kit"] = &makeResolvedRepo().Repository
	store.bookshelfResolved["u1|octo/kit"] = makeResolvedRepo()
	store.bookshelfRepos["u1"] = []BookshelfRepoRow{
		{
			RepoRow: RepoRow{
				ID: "repo-1", Owner: "octo", Repo: "kit", Branch: "main", McpStatus: "ACTIVE",
				Category: "Framework", IsPublic: true, Edition: "",
			},
		},
	}
}

func callRead(t *testing.T, ts *httptest.Server, path, toolName, arguments string) (*http.Response, string) {
	t.Helper()
	body := `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"` + toolName + `","arguments":` + arguments + `}}`
	req, _ := http.NewRequest(http.MethodPost, ts.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+goodToken)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	return resp, readAll(t, resp.Body)
}

// parseResultText 从 JSON-RPC 响应抽取 result.content[0].text 与 isError。
func parseResultText(t *testing.T, body string) (text string, isError bool) {
	t.Helper()
	var parsed struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			IsError bool `json:"isError"`
		} `json:"result"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	err := json.Unmarshal([]byte(body), &parsed)
	require.NoError(t, err, "invalid JSON-RPC response:\n%s", body)
	if parsed.Error != nil {
		return parsed.Error.Message, false
	}
	require.NotEmpty(t, parsed.Result.Content, "no content block: %s", body)
	return parsed.Result.Content[0].Text, parsed.Result.IsError
}

func waitCallLogs(t *testing.T, store *readFakeStore) []CallLogEntry {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		store.mu.Lock()
		n := len(store.callLogs)
		store.mu.Unlock()
		if n > 0 {
			store.mu.Lock()
			logs := append([]CallLogEntry(nil), store.callLogs...)
			store.mu.Unlock()
			return logs
		}
		time.Sleep(10 * time.Millisecond)
	}
	require.FailNow(t, "telemetry call log never arrived")
	return nil
}

// ── 用例 ──

// 🧪 [7.9.1.1] ownerUserId 冻结规则：仅允许读取共享文档（ownerUserId IS NULL）或本人副本，他人副本隔离
func TestNativeReadOwnerUserIdIsolation(t *testing.T) {
	tests := []struct {
		name        string
		docID       string
		docPath     string
		docOwner    *string
		reqUser     string
		wantSuccess bool
	}{
		{
			name:        "shared doc (ownerUserId IS NULL) is accessible",
			docID:       "doc-shared",
			docPath:     "docs/shared.md",
			docOwner:    nil,
			reqUser:     "u1",
			wantSuccess: true,
		},
		{
			name:        "own private copy (ownerUserId = reqUser) is accessible",
			docID:       "doc-own",
			docPath:     "docs/own.md",
			docOwner:    str("u1"),
			reqUser:     "u1",
			wantSuccess: true,
		},
		{
			name:        "other user private copy (ownerUserId != reqUser) is isolated and returns not found",
			docID:       "doc-other",
			docPath:     "docs/other.md",
			docOwner:    str("u-other"),
			reqUser:     "u1",
			wantSuccess: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newReadFakeStore()
			seedAuth(t, store)
			ts := readTestServer(t, store, nil)

			repo := store.resolved["octo/kit"]
			repo.Documents = append(repo.Documents, DocMeta{ID: tt.docID, Path: tt.docPath, Title: "Test Doc"})
			store.docContent[tt.docID] = str("Document content for " + tt.docPath)
			store.docOwners[tt.docID] = tt.docOwner

			resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"`+tt.docPath+`"}`)
			defer resp.Body.Close()
			text, isError := parseResultText(t, body)

			if tt.wantSuccess {
				assert.False(t, isError)
				assert.Contains(t, text, "Document content for "+tt.docPath)
			} else {
				assert.True(t, isError)
				assert.Contains(t, text, "has no readable content")
			}
		})
	}
}

// 🧪 [7.9.2.1] 输出模板逐字一致：全文模板对齐 Node
func TestNativeReadFullDocTemplateVerbatim(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	content := "# Hello\n\nWorld"
	store.docContent["doc-1"] = str(content)

	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"README.md"}`)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	text, isError := parseResultText(t, body)
	require.False(t, isError, "unexpected isError: %s", text)
	// Node 模板：`# ${title}\nSource Path: ${path}\n${liveUrlLine}\n${content}`（liveUrlLine 空时是裸 \n）
	want := "# Getting Started\nSource Path: README.md\n\n" + content
	assert.Equal(t, want, text)
	assert.Contains(t, body, `"id":7`, "JSON-RPC id must be echoed verbatim")
	assert.NotContains(t, body, "isError", "isError must be absent on success")
}

func TestNativeReadAspectFiltering(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	content := "# Scheduler Design\n\nIntroductory tutorial narrative paragraph that explains concepts.\n\n" +
		"```go\nfunc Worker() {\n\t// line 1\n\t// line 2\n\t// line 3\n\t// line 4\n\t// line 5\n\t// line 6\n\t// line 7\n}\n```\n\n" +
		"| Param | Type |\n| --- | --- |\n| queue | PriorityQueue |\n"
	store.docContent["doc-1"] = str(content)

	ts := readTestServer(t, store, nil)

	t.Run("architecture 模式折叠长代码块保留叙述与表格", func(t *testing.T) {
		resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"README.md","aspect":"architecture"}`)
		defer resp.Body.Close()
		text, isError := parseResultText(t, body)
		require.False(t, isError)
		assert.Contains(t, text, "Introductory tutorial narrative paragraph")
		assert.Contains(t, text, "Code implementation omitted in architecture mode")
		assert.NotContains(t, text, "func Worker() {")
	})

	t.Run("contract 模式保留标题代码块与表格剥离叙述", func(t *testing.T) {
		resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"README.md","aspect":"contract"}`)
		defer resp.Body.Close()
		text, isError := parseResultText(t, body)
		require.False(t, isError)
		assert.Contains(t, text, "# Getting Started")
		assert.Contains(t, text, "func Worker() {")
		assert.Contains(t, text, "| Param | Type |")
		assert.NotContains(t, text, "Introductory tutorial narrative paragraph")
	})
}

func TestNativeReadPathToleranceAndSectionExact(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.chunks["doc-2"] = []Chunk{
		{Heading: str("Overview"), HeadingPath: str("docs/guide.md#Overview"), Content: "intro text"},
		{Heading: str("Install"), HeadingPath: str("docs/guide.md#Install"), Content: "install steps"},
	}

	ts := readTestServer(t, store, nil)
	// 路径容差：docs/guide（无后缀）命中 docs/guide.md
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"docs/guide#Install"}`)
	defer resp.Body.Close()

	text, isError := parseResultText(t, body)
	require.False(t, isError, "unexpected isError: %s", text)
	// 分节模板：`# title\nSource Path: path\nSection: heading\n\ncontent`
	want := "# Guide\nSource Path: docs/guide.md\nSection: Install\n\ninstall steps"
	assert.Equal(t, want, text)
}

func TestNativeReadSectionContainsFallback(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.chunks["doc-2"] = []Chunk{
		{Heading: str("Deep"), HeadingPath: str("Guide > Deep Dive > Part One"), Content: "deep content"},
	}

	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"docs/guide.md#Deep Dive"}`)
	defer resp.Body.Close()

	text, _ := parseResultText(t, body)
	assert.Contains(t, text, "deep content", "contains fallback should hit")
}

func TestNativeReadAnchorMissFallsBackToFullDoc(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.chunks["doc-1"] = []Chunk{
		{Heading: str("Other"), HeadingPath: str("README.md#Other"), Content: "other"},
	}
	store.docContent["doc-1"] = str("full body")

	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"README.md#Missing"}`)
	defer resp.Body.Close()

	text, isError := parseResultText(t, body)
	require.False(t, isError, "anchor miss is not an error: %s", text)
	// 锚点未命回退模板：无裸换行（liveUrlLine 后直接接截断文本）
	want := "# Getting Started\nSource Path: README.md\nfull body"
	assert.Equal(t, want, text)
}

func TestNativeReadGraphPositionInjection(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.chunks["doc-2"] = []Chunk{
		{Heading: str("Overview"), HeadingPath: str("docs/guide.md#Overview"), Content: "intro"},
	}
	store.concepts["doc-2|Overview"] = &ConceptNodeLite{
		ID: "c1", ConceptName: "上下文设计", Category: "architecture",
	}
	store.memberIDs["c1"] = []string{"c1"}
	store.edges = []EdgeRef{
		{SourceID: "c2", TargetID: "c1", Type: "prerequisite", Weight: 0.9, Source: "curriculum_order"},
	}
	store.nodesByID["c2"] = ConceptNodeLite{ID: "c2", ConceptName: "基础概念"}

	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"docs/guide.md#Overview"}`)
	defer resp.Body.Close()

	text, _ := parseResultText(t, body)
	assert.True(t, strings.HasPrefix(text, "🧭 图位置 (Graph Position): 本节属于「上下文设计」(architecture)\n- 直接邻居: ⇠[前置]基础概念 (⇠=我依赖它 ⇢=它依赖我 ⇋=无向关联)\n\n"))
}

// 🧪 [7.9.3.1] 遥测写集：文档缺失记录 BLIND_SPOT 落 McpCallLog + mcpCallCount increment
func TestNativeReadDocNotFoundBlindSpotTelemetry(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)

	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"nope.md"}`)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode, "tool-level error is HTTP 200")
	text, isError := parseResultText(t, body)
	assert.True(t, isError)
	assert.Equal(t, `Error: Document "nope.md" not found in octo/kit. Call outline to view valid document paths.`, text)

	logs := waitCallLogs(t, store)
	require.Len(t, logs, 1)
	assert.Equal(t, "BLIND_SPOT", logs[0].Status)
	assert.Equal(t, "documents", logs[0].Dimension)
	assert.Equal(t, "read", logs[0].ToolName)
	assert.NotEmpty(t, store.incRepoCalls, "Repository.mcpCallCount must be incremented")
}

func TestNativeReadMissingTargetMessage(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{}`)
	defer resp.Body.Close()
	text, isError := parseResultText(t, body)
	want := `Error: "target" is required. Pass a document path (e.g. "README.md") or section address (e.g. "README.md#Usage"). Use outline to see available documents.`
	assert.True(t, isError)
	assert.Equal(t, want, text)
}

func TestNativeRead16KCharCapSuffix(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	long := strings.Repeat("a", 17000)
	store.docContent["doc-1"] = str(long)

	ts := readTestServer(t, store, nil)
	// 用户 cap 足够大，policy 无 → 只有 16K 字符截断生效
	store.quotas["u1"] = UserQuota{Role: "ADMIN", Tier: "ENTERPRISE", RpmLimit: 600, DailyLimit: 0, TokenCap: 32000}
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"README.md"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.Contains(t, text, "... [Truncated for context limit. Use outline for the table of contents, or pass target with an Address (path#heading) to read a specific section.]")
}

// 🧪 [7.9.2.2] token 预算截断对 CJK 低估防护：estimateTokens = ceil(CJK*1.3 + 非CJK*0.25)
func TestNativeReadTokenBudgetCJKTruncation(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	// CJK 内容：estimateTokens = cjk*1.3 → 8000 字 ≈ 10400 tokens > 用户 cap 1000
	store.docContent["doc-1"] = str(strings.Repeat("字", 8000))
	store.quotas["u1"] = UserQuota{Role: "USER", Tier: "FREE", RpmLimit: 30, DailyLimit: 100, TokenCap: 1000}

	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"README.md"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.Contains(t, text, "...[Content truncated to fit token budget]")
	assert.LessOrEqual(t, estimateTokens(text), 1500, "post-truncation estimate should be within budget")
}

func TestNativeReadAliasRewriteGetDocument(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.docContent["doc-2"] = str("guide body")

	ts := readTestServer(t, store, nil)
	// get_document + path（无 target）→ 别名改写为 read(target=path)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "get_document", `{"path":"docs/guide.md"}`)
	defer resp.Body.Close()
	text, isError := parseResultText(t, body)
	require.False(t, isError)
	assert.Contains(t, text, "guide body")
}

// 🧪 [7.9.4.1] 门控边界：policy/tier 禁用回落透传
func TestDisabledReadPolicyFallsBackToProxy(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.policies["read"] = ToolPolicy{IsEnabled: false, TokenBudget: 4000, TierRequirement: "FREE"}
	upstreamHit := false
	ts := readTestServer(t, store, &upstreamHit)

	resp, _ := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"README.md"}`)
	defer resp.Body.Close()
	assert.True(t, upstreamHit, "disabled policy must fall back to proxy")
}

// 🧪 [7.13.4.1] 门面语义：别名纯名改写怪癖，skill_coverage 无 action 走 details
func TestHubOnlyConceptModesStayOnHub(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	ts := readTestServer(t, store, nil)

	tests := []struct {
		name      string
		toolName  string
		arguments string
		wantBody  string
	}{
		{
			name:      "explicit action coverage returns static hub hint",
			toolName:  "explore_concept",
			arguments: `{"concept":"react","action":"coverage"}`,
			wantBody:  "Skill coverage analysis is available on Hub mode.",
		},
		{
			name:      "alias skill_coverage without action falls to details semantics",
			toolName:  "skill_coverage",
			arguments: `{"concept":"react"}`,
			wantBody:  "not found in octo/kit",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, body := callRead(t, ts, "/api/mcp/octo/kit", tt.toolName, tt.arguments)
			defer resp.Body.Close()
			assert.Contains(t, body, tt.wantBody)
		})
	}
}

// 🧪 [7.9.4.2] 仓库门禁信封漂移：404/503/403 返回结构化 JSON-RPC 信封与 CORS
func TestNativeReadRepoGateEnvelopes(t *testing.T) {
	tests := []struct {
		name       string
		setup      func(store *readFakeStore)
		wantStatus int
		wantBody   string
		checkCORS  bool
	}{
		{
			name: "PAUSED status returns 503",
			setup: func(store *readFakeStore) {
				seedAuth(t, store)
				paused := makeResolvedRepo()
				paused.Repository.McpStatus = "PAUSED"
				store.repos["octo/kit"] = &paused.Repository
			},
			wantStatus: http.StatusServiceUnavailable,
			wantBody:   "currently paused",
		},
		{
			name: "private repo without access returns 403",
			setup: func(store *readFakeStore) {
				seedAuth(t, store)
				priv := makeResolvedRepo()
				priv.Repository.IsPublic = false
				store.repos["octo/kit"] = &priv.Repository
			},
			wantStatus: http.StatusForbidden,
			wantBody:   `"code":-32001`,
		},
		{
			name: "repo not found returns 404 with CORS",
			setup: func(store *readFakeStore) {
				store.tokens[sha256Hex(goodToken)] = &TokenRecord{TokenID: "t1", UserID: "u1"}
			},
			wantStatus: http.StatusNotFound,
			wantBody:   "Repository not found",
			checkCORS:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newReadFakeStore()
			tt.setup(store)
			ts := readTestServer(t, store, nil)
			resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read", `{"target":"README.md"}`)
			defer resp.Body.Close()
			assert.Equal(t, tt.wantStatus, resp.StatusCode)
			assert.Contains(t, body, tt.wantBody)
			if tt.checkCORS {
				assert.NotEmpty(t, resp.Header.Get("Access-Control-Allow-Origin"), "repo-gate errors must carry CORS headers")
			}
		})
	}
}

func TestHubRouteReadNative(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.docContent["doc-1"] = str("# Getting Started\n\nHello from kit!")
	upstreamHit := false
	ts := readTestServer(t, store, &upstreamHit)

	// Missing repository parameter should return scope required error natively
	resp1, raw1 := callRead(t, ts, "/api/mcp/hub", "read", `{"target":"README.md"}`)
	defer resp1.Body.Close()
	text1, isErr1 := parseResultText(t, raw1)
	assert.False(t, upstreamHit)
	assert.True(t, isErr1)
	assert.Contains(t, text1, "repository")

	// With repository parameter should succeed natively
	resp2, raw2 := callRead(t, ts, "/api/mcp/hub", "read", `{"repository":"octo/kit","target":"README.md"}`)
	defer resp2.Body.Close()
	text2, isErr2 := parseResultText(t, raw2)
	assert.False(t, upstreamHit)
	assert.False(t, isErr2)
	assert.Contains(t, text2, "Getting Started")
}

// ── Phase 2c：outline / list_resources fake 扩展 ──

type chunkHeadingRow struct {
	docID string
	rows  []ChunkHeading
}

type docConceptRow struct {
	key  string // "repoID|docID"
	rows []ConceptNodeLite
}

func (f *readFakeStore) ListChunkHeadings(_ context.Context, docID string, take int) ([]ChunkHeading, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	rows := f.chunkHeadings[docID]
	if len(rows) > take {
		rows = rows[:take]
	}
	return rows, nil
}

func (f *readFakeStore) ListDocConcepts(_ context.Context, repositoryID, documentID string, take int) ([]ConceptNodeLite, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	rows := f.docConcepts[repositoryID+"|"+documentID]
	if len(rows) > take {
		rows = rows[:take]
	}
	return rows, nil
}

func (f *readFakeStore) TaxonomyNodes(_ context.Context, repositoryID string, take int) ([]TaxonomyNode, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	rows := f.taxonomy[repositoryID]
	if len(rows) > take {
		rows = rows[:take]
	}
	return rows, nil
}

func (f *readFakeStore) PrereqEdges(_ context.Context, repositoryID string) ([]EdgeRef, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.prereqEdges[repositoryID], nil
}

// ── Phase 2c 用例 ──

// 🧪 [7.10.1.1] TOC 深度缩进与去重漂移：逐字断言 doc-mode 模板与重复 chunk 去重
func TestNativeOutlineDocModeTemplate(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.chunkHeadings["doc-2"] = []ChunkHeading{
		{Heading: str("Overview"), HeadingPath: str("Guide > Overview"), ContentType: str("prose")},
		{Heading: str("API"), HeadingPath: str("Guide > Reference > API"), ContentType: str("code")},
		{Heading: str("Overview"), HeadingPath: str("Guide > Overview")}, // 重复键去重
	}
	store.docConcepts["repo-1|doc-2"] = []ConceptNodeLite{
		{ConceptName: "上下文设计", Category: "architecture", DocumentPath: str("docs/guide.md"), HeadingPath: str("docs/guide.md#上下文设计")},
	}
	summary := "Guide summary"
	store.resolved["octo/kit"].Documents[1].Summary = &summary

	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "outline", `{"path":"docs/guide"}`)
	defer resp.Body.Close()
	text, isError := parseResultText(t, body)
	require.False(t, isError, "unexpected isError: %s", text)

	want := "📄 Guide\nPath: docs/guide.md\nSummary: Guide summary\n\n## Internal Headings (TOC)\n" +
		"  - Overview [Address: docs/guide.md#Guide > Overview]\n" +
		"    - API [code] [Address: docs/guide.md#Guide > Reference > API]\n" +
		"\n## 🧠 Knowledge Graph Concepts (Tutorial Concept Map)\n" +
		"- 上下文设计 (architecture) — docs/guide.md [Address: docs/guide.md#上下文设计]\n" +
		"\n(Use read with target=\"docs/guide.md\" for the whole document, or target=\"<Address>\" to read a specific section)"
	assert.Equal(t, want, text)
}

func TestNativeOutlineEmptyChunksHint(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "toc", `{"path":"README.md"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.Contains(t, text, "(No internal heading chunks available. Use read with target=\"README.md\" to read the full page.)")
}

func TestNativeOutlineDocNotFound(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "outline", `{"path":"nope.md"}`)
	defer resp.Body.Close()
	text, isError := parseResultText(t, body)
	want := `Document not found: "nope.md" in octo/kit. Call outline without "path" to see available documents.`
	assert.True(t, isError)
	assert.Equal(t, want, text)
}

// 🧪 [7.10.2.1] taxonomy 深度/归并标注：松弛深度 [前置×N] 与同义词 ×N 标注
func TestNativeOutlineRepoModeNavTreeAndTaxonomy(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	nav := `[{"type":"directory","title":"Docs","children":[{"type":"file","title":"Guide","path":"docs/guide.md"}]},{"type":"file","title":"README","path":"README.md"}]`
	res := store.resolved["octo/kit"]
	res.Repository.NavTree = json.RawMessage(nav)
	store.taxonomy["repo-1"] = []TaxonomyNode{
		{ID: "n1", ConceptName: "事件循环", CanonicalKey: str("event-loop"), CanonicalName: str("事件循环"), Category: "architecture", DocumentPath: str("docs/guide.md"), HeadingPath: str("Guide > Event Loop")},
		{ID: "n2", ConceptName: "事件循环（下）", CanonicalKey: str("event-loop"), CanonicalName: str("事件循环"), Category: "architecture", DocumentPath: str("README.md"), HeadingPath: str("Event Loop II")},
		{ID: "n3", ConceptName: "基础概念", Category: "principle", DocumentPath: str("README.md")},
	}
	store.prereqEdges["repo-1"] = []EdgeRef{
		{SourceID: "n3", TargetID: "n1", Type: "prerequisite", Weight: 1},
	}

	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "outline", `{}`)
	defer resp.Body.Close()
	text, isError := parseResultText(t, body)
	require.False(t, isError, "unexpected isError: %s", text)

	assert.True(t, strings.HasPrefix(text, "Available Documentation in octo/kit:\n\n📁 Docs\n  📄 Guide (docs/guide.md)\n📄 README (README.md)\n"))
	assert.Contains(t, text, "\n---\n\n## 🧠 Knowledge Graph Concepts (Tutorial Concept Map)\n\n")

	// architecture 组 2 项 > principle 1 项 → architecture 在前；归并组（×2 处同义）；
	// n3 是 n1 的前置 → depth 1 → [前置×1]
	archIdx := strings.Index(text, "### 🗂️ architecture (1)")
	principleIdx := strings.Index(text, "### 🗂️ principle (1)")
	assert.True(t, strings.Contains(text, "### 🗂️ architecture (1)"))
	assert.True(t, principleIdx > archIdx, "architecture must precede principle")
	assert.Contains(t, text, "  - 基础概念 [前置×1] — README.md")
	assert.Contains(t, text, "- 事件循环 ×2 处同义 — docs/guide.md [Address: docs/guide.md#Guide > Event Loop]")
	assert.True(t, strings.HasSuffix(text, "(Use get_concept_details (concept: \"<name>\") to dive into any concept above, or read_section with its Address for the source section.)\n(Next steps: use outline with \"path\" to inspect document headings, search to find keywords, or read with \"target\" to read content.)"))
	assert.Contains(t, text, "(Next steps: use outline with \"path\" to inspect document headings, search to find keywords, or read with \"target\" to read content.)")
}

// 🧪 [7.10.1.2] 空 navTree 回落文档清单防护：空数组走树模式空文本不列文档
func TestNativeOutlineRepoModeEmptyNavTreeUsesTreeMode(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.resolved["octo/kit"].Repository.NavTree = json.RawMessage("[]")
	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "outline", `{}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	// 空数组也是 Array.isArray → 树模式（空文本），不回落文档清单
	assert.NotContains(t, text, "- Getting Started (README.md)", "empty navTree must NOT fall back to doc listing")
	assert.True(t, strings.HasPrefix(text, "Available Documentation in octo/kit:\n\n"))
}

// 🧪 [7.10.4.2] 门面翻转：read_document 无参原生执行 outline 且 upstream 不可达
func TestReadDocumentNoArgsNowRunsNativeOutline(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	upstreamHit := false
	ts := readTestServer(t, store, &upstreamHit)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "read_document", `{}`)
	defer resp.Body.Close()
	assert.False(t, upstreamHit, "read_document no-args must now run native outline (Phase 2c flip)")
	assert.Contains(t, body, "Available Documentation in octo/kit:")
}

// 🧪 [7.10.3.1] 遥测语义：list_resources 单仓成功路径不写 McpCallLog 遥测
func TestNativeListResourcesSingleRepoTemplate(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.resolved["octo/kit"].Repository.Category = "Framework"
	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "list_resources", `{"query":"ignored-in-single-repo"}`)
	defer resp.Body.Close()
	text, isError := parseResultText(t, body)
	require.False(t, isError, "unexpected isError: %s", text)

	want := "Repository: octo/kit\n- Category: Framework\n- Total Documents: 2\n- Target Version: main\n"
	assert.Equal(t, want, text)

	// 单仓模式无成功遥测（对齐 Node：runListResources 不写 McpCallLog）
	store.mu.Lock()
	logs := len(store.callLogs)
	store.mu.Unlock()
	assert.Equal(t, 0, logs, "list_resources must not write McpCallLog on success")
}

func TestListResourcesAliasDispatch(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "list_tutorials", `{}`)
	defer resp.Body.Close()
	assert.Contains(t, body, "Repository: octo/kit", "list_tutorials alias must dispatch natively")
}

func TestTargetVersionFallsBackToBranch(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	// 无 semVerLabel → targetVersionLabel 回退 resolvedBranch（Phase 2b 遗留缺陷修复）
	store.resolved["octo/kit"].Repository.Branch = "master"
	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "list_resources", `{}`)
	defer resp.Body.Close()
	assert.Contains(t, body, "- Target Version: master")
}

// 🧪 [7.10.4.1] 别名族规范名门控：toc 别名按 outline 规范名查 policy 禁用时回退透传
func TestOutlineDisabledPolicyFallsBackToProxy(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.policies["outline"] = ToolPolicy{IsEnabled: false, TokenBudget: 4000, TierRequirement: "FREE"}
	upstreamHit := false
	ts := readTestServer(t, store, &upstreamHit)
	resp, _ := callRead(t, ts, "/api/mcp/octo/kit", "toc", `{}`)
	defer resp.Body.Close()
	assert.True(t, upstreamHit, "disabled outline policy must fall back to proxy")
}

// ── Phase 2e：search fake 扩展 ──

func (f *readFakeStore) SearchChunks(_ context.Context, req SearchChunksRequest) ([]SearchChunkHit, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastSearchReq = req

	q := strings.TrimSpace(req.Query)
	rawQ := strings.TrimSpace(req.RawQuery)
	fallbackQ := rawQ
	if fallbackQ == "" {
		fallbackQ = q
	}
	searchQ := q
	if searchQ == "" {
		searchQ = fallbackQ
	}
	if searchQ == "" {
		return []SearchChunkHit{}, nil
	}

	rows := f.searchFTSRows(searchQ)
	if len(rows) == 0 && fallbackQ != "" && fallbackQ != searchQ {
		rows = f.searchFTSRows(fallbackQ)
	}
	if len(rows) == 0 {
		rows = f.substringRows(fallbackQ)
	}
	if len(rows) == 0 {
		tokens := locatorTokensOf(fallbackQ)
		var valid []string
		for _, t := range tokens {
			if len([]rune(t)) >= 2 {
				valid = append(valid, t)
			}
		}
		if len(valid) > 1 {
			for _, t := range valid {
				if r := f.substringRows(t); len(r) > 0 {
					rows = append(rows, r...)
					break
				}
			}
		}
	}

	hits := make([]SearchChunkHit, 0, len(rows))
	cumulativeTokens := 0
	for _, r := range rows {
		if r.OwnerUserID != nil {
			if req.UserID == nil || *req.UserID == "" || *req.UserID != *r.OwnerUserID {
				continue
			}
		}

		content := deref(r.Content)
		textLen := len([]rune(content))
		estTokens := int(math.Ceil(float64(textLen) * 0.25))
		if req.TokenBudget > 0 && cumulativeTokens+estTokens > req.TokenBudget && len(hits) > 0 {
			break
		}
		cumulativeTokens += estTokens

		title := deref(r.Title)
		path := deref(r.Path)
		var sim float64 = 0.5
		if r.FtsRank != nil {
			sim = *r.FtsRank
		}
		snippet := buildLocatorSnippet(content, []string{fallbackQ})

		var edLabel *string
		if r.RepoEdition != nil && *r.RepoEdition != "" {
			l := deriveEditionLabel(r.RepoProfile)
			edLabel = &l
		}

		hit := SearchChunkHit{
			ChunkID:      r.ChunkID,
			DocID:        r.DocID,
			Title:        title,
			Path:         path,
			Heading:      r.Heading,
			HeadingPath:  r.HeadingPath,
			Snippet:      snippet,
			Similarity:   sim,
			EditionLabel: edLabel,
			FtsRank:      r.FtsRank,
		}
		if req.IncludeContent {
			hit.Content = content
		}
		hits = append(hits, hit)
		if req.Limit > 0 && len(hits) >= req.Limit {
			break
		}
	}
	return hits, nil
}

// searchFTSRows fake FTS：query 子串命中 heading/content 的 chunk。
func (f *readFakeStore) searchFTSRows(query string) []rawChunkRow {
	if query == "" || f.chunksIndex == nil {
		return nil
	}
	var out []rawChunkRow
	for _, row := range f.chunksIndex {
		if strings.Contains(strings.ToLower(deref(row.Heading)), strings.ToLower(query)) ||
			strings.Contains(strings.ToLower(deref(row.Content)), strings.ToLower(query)) {
			rank := 0.7
			row.FtsRank = &rank
			out = append(out, row)
		}
	}
	return out
}

func (f *readFakeStore) substringRows(searchStr string) []rawChunkRow {
	if searchStr == "" || f.chunksIndex == nil {
		return nil
	}
	var out []rawChunkRow
	for _, row := range f.chunksIndex {
		if strings.Contains(strings.ToLower(deref(row.Content)), strings.ToLower(searchStr)) {
			rank := 0.5
			row.FtsRank = &rank
			out = append(out, row)
		}
	}
	return out
}

func (f *readFakeStore) MatchConceptAll(_ context.Context, _ string, keywords []string) (*ConceptRichNode, error) {
	for _, n := range f.conceptRich {
		all := true
		for _, kw := range keywords {
			if !strings.Contains(strings.ToLower(n.ConceptName), strings.ToLower(kw)) {
				all = false
				break
			}
		}
		if all {
			return &n, nil
		}
	}
	return nil, nil
}

func (f *readFakeStore) MatchConceptAny(_ context.Context, _ string, keywords []string) (*ConceptRichNode, error) {
	for _, n := range f.conceptRich {
		for _, kw := range keywords {
			if strings.Contains(strings.ToLower(n.ConceptName), strings.ToLower(kw)) {
				return &n, nil
			}
		}
	}
	return nil, nil
}

func (f *readFakeStore) MatchConceptBody(_ context.Context, _ string, keywords []string) (*ConceptRichNode, error) {
	for _, n := range f.conceptRich {
		for _, kw := range keywords {
			if strings.Contains(strings.ToLower(deref(n.Summary)), strings.ToLower(kw)) {
				return &n, nil
			}
		}
	}
	return nil, nil
}

func (f *readFakeStore) ConceptGramCandidates(_ context.Context, _ string, _ []string) ([]ConceptRichNode, error) {
	return nil, nil
}

func (f *readFakeStore) ConceptDependencyEdges(_ context.Context, _ string, _ []string) ([]EdgeRef, error) {
	return f.depEdges, nil
}

func (f *readFakeStore) GetRepoGitSha(_ context.Context, _ string) (string, string, string, bool) {
	return f.repoGitSha.owner, f.repoGitSha.repo, f.repoGitSha.sha, f.repoGitSha.ok
}

// ── Phase 2f：explore_concept fake 扩展 ──

func (f *readFakeStore) ResolveConceptNode(_ context.Context, _, concept string) (*ConceptRichNode, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	trimmed := strings.TrimSpace(concept)
	if trimmed == "" {
		return nil, nil
	}
	key := normalizeHeadingKey(trimmed)
	// ① exact-insensitive OR（slug/conceptName/canonicalName + 非空 canonicalKey=normalizeHeadingKey）
	for _, n := range f.conceptRich {
		if strings.EqualFold(n.ConceptName, trimmed) || strings.EqualFold(n.Slug, trimmed) ||
			(n.CanonicalName != nil && strings.EqualFold(*n.CanonicalName, trimmed)) ||
			(key != "" && n.CanonicalKey != nil && strings.EqualFold(*n.CanonicalKey, key)) {
			return &n, nil
		}
	}
	// ② 前缀兜底
	for _, n := range f.conceptRich {
		if strings.HasPrefix(strings.ToLower(n.ConceptName), strings.ToLower(trimmed)) {
			return &n, nil
		}
	}
	return nil, nil
}

func (f *readFakeStore) LearningPathEdges(_ context.Context, _ string) ([]EdgeRef, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []EdgeRef
	for _, e := range f.prereqEdgesAll {
		if e.Type == "prerequisite" || e.Type == "successor" {
			out = append(out, e)
		}
	}
	return out, nil
}

func (f *readFakeStore) CountCanonicalMembers(_ context.Context, _, canonicalKey string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, n := range f.conceptRich {
		if n.CanonicalKey != nil && *n.CanonicalKey == canonicalKey {
			count++
		}
	}
	if count == 0 {
		return 1
	}
	return count
}
