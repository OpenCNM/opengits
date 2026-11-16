package webdoc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSanitizeMarkdown(t *testing.T) {
	tests := []struct {
		name     string
		docPath  string
		raw      string
		contains string
	}{
		{
			name:     "plain text without html",
			docPath:  "guide.md",
			raw:      "# Hello World\n\nThis is pure markdown.",
			contains: "Hello World",
		},
		{
			name:     "html tags stripped or cleaned",
			docPath:  "index.md",
			raw:      "<h1>Title</h1><p>Body with <script>alert(1)</script></p>",
			contains: "Title",
		},
		{
			name:     "mdx curly braces healed",
			docPath:  "component.mdx",
			raw:      "Here is a code snippet with {unclosed bracket in text",
			contains: "unclosed",
		},
		{
			name:     "mdx curly braces healed inside CardGroup at byte zero",
			docPath:  "cards.mdx",
			raw:      "<CardGroup cols=\"2\">\n<Card title=\"Webhook\" href=\"/docs/webhook\">\n\nSend payload { \"event\": \"ok\" } to endpoint.\n\n</Card>\n</CardGroup>",
			contains: "&#123; \"event\": \"ok\" &#125;",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SanitizeMarkdown(tt.docPath, tt.raw)
			assert.Contains(t, got, tt.contains)
		})
	}
}

type fakeIngestStore struct {
	mu           sync.Mutex
	upsertRepo   *IngestRepoParams
	docs         []IngestDocParams
	snapshot     *IngestSnapshotParams
	storedDraft  OutlineDraft
	storedActive bool
	progressLogs []struct {
		Step     string
		Progress int
	}
	failAt string
}

func (f *fakeIngestStore) UpsertRepositoryRow(_ context.Context, p IngestRepoParams) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failAt == "upsert_repo" {
		return "", fmt.Errorf("upsert repo error")
	}
	f.upsertRepo = &p
	return "repo-123", nil
}

func (f *fakeIngestStore) UpsertOwnedDocument(_ context.Context, args IngestDocParams) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failAt == "upsert_doc" {
		return "", fmt.Errorf("upsert doc error")
	}
	f.docs = append(f.docs, args)
	return fmt.Sprintf("doc-%d", len(f.docs)), nil
}

func (f *fakeIngestStore) RegisterImportSnapshot(_ context.Context, p IngestSnapshotParams) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failAt == "snapshot" {
		return false, fmt.Errorf("snapshot error")
	}
	f.snapshot = &p
	return true, nil
}

func (f *fakeIngestStore) UpdateImportJobProgress(_ context.Context, _ string, step string, progress int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.progressLogs = append(f.progressLogs, struct {
		Step     string
		Progress int
	}{Step: step, Progress: progress})
	return nil
}

func (f *fakeIngestStore) StoreOutlineDraft(_ context.Context, _ string, draft OutlineDraft, isActive bool) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failAt == "store_outline" {
		return "", fmt.Errorf("store outline error")
	}
	f.storedDraft = draft
	f.storedActive = isActive
	return "outline-123", nil
}

type mockFirecrawlAPI struct {
	scrapeFn func(ctx context.Context, url string) (*FirecrawlDoc, error)
	crawlFn  func(ctx context.Context, url string, limit int, filters *CrawlFilters) ([]FirecrawlDoc, error)
}

func (m *mockFirecrawlAPI) ScrapeUrl(ctx context.Context, url string) (*FirecrawlDoc, error) {
	if m.scrapeFn != nil {
		return m.scrapeFn(ctx, url)
	}
	return nil, fmt.Errorf("unsupported")
}

func (m *mockFirecrawlAPI) Crawl(ctx context.Context, url string, limit int, filters *CrawlFilters) ([]FirecrawlDoc, error) {
	if m.crawlFn != nil {
		return m.crawlFn(ctx, url, limit, filters)
	}
	return nil, fmt.Errorf("unsupported")
}

func TestRunIngest_EmptyURL(t *testing.T) {
	store := &fakeIngestStore{}
	var emittedType string
	outcome := RunIngest(context.Background(), IngestDeps{
		Store: store,
		Emit: func(eventType string, payload map[string]any) {
			emittedType = eventType
		},
	}, IngestJob{
		ID:    "job-1",
		Owner: "owner",
		Repo:  "repo",
	}, IngestOptions{
		URL: "",
	})

	assert.Equal(t, IngestFallback, outcome)
	assert.Equal(t, "error", emittedType)
}

func TestRunIngest_FastPathSuccess(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)
	t.Setenv("WEB_CRAWLER_POLITENESS_DELAY_MS", "0")

	// 启动模拟静态站
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(staticTestPage("Test Static Site", `<p>Intro text long enough to pass minimum extraction thresholds with plenty of details about the site, its purpose, the intended audience, and the overall structure of the documentation being published here.</p>`)))
	}))
	defer ts.Close()

	store := &fakeIngestStore{}
	var settledRepoID string
	var settledDocsCount int
	var emittedLogs []string
	var emitMu sync.Mutex

	outcome := RunIngest(context.Background(), IngestDeps{
		Store: store,
		Emit: func(eventType string, payload map[string]any) {
			if eventType == "log" {
				emitMu.Lock()
				defer emitMu.Unlock()
				if msg, ok := payload["message"].(string); ok {
					emittedLogs = append(emittedLogs, msg)
				}
			}
		},
		Settle: func(_ context.Context, _ string, res SettleResult) error {
			settledRepoID = res.RepositoryID
			settledDocsCount = res.QueuedDocumentsCount
			return nil
		},
		BuildNavTree: func(nodes []GitNode, _, _ string, _ int) []byte {
			return []byte(`[{"title":"home"}]`)
		},
	}, IngestJob{
		ID:     "job-2",
		Owner:  "acme",
		Repo:   "docs",
		UserID: "user-1",
	}, IngestOptions{
		URL:            ts.URL,
		MaxPages:       5,
		IsPublic:       true,
		TargetLanguage: "zh",
	})

	assert.Equal(t, IngestDone, outcome)
	assert.Equal(t, "repo-123", settledRepoID)
	assert.Positive(t, settledDocsCount)
	require.NotNil(t, store.upsertRepo)
	assert.Equal(t, "acme", store.upsertRepo.Owner)
	assert.Equal(t, "docs", store.upsertRepo.Repo)
	assert.True(t, store.upsertRepo.IsPublic)
	assert.NotEmpty(t, store.docs)
	require.NotNil(t, store.snapshot)
	assert.NotEmpty(t, emittedLogs, "web-doc ingest must emit real-time logs")
	assert.Contains(t, emittedLogs[0], "[1/3]")
	assert.Contains(t, emittedLogs[len(emittedLogs)-1], "全部解析入库完成")
}

func TestRunIngest_FirecrawlFallback(t *testing.T) {
	store := &fakeIngestStore{}
	fc := &mockFirecrawlAPI{
		crawlFn: func(_ context.Context, _ string, _ int, _ *CrawlFilters) ([]FirecrawlDoc, error) {
			return []FirecrawlDoc{
				{
					Path:        "intro.md",
					Title:       "Intro",
					Markdown:    "# Intro\nWelcome",
					ContentHash: "hash-intro",
				},
				{
					Path:        "setup.md",
					Title:       "Setup",
					Markdown:    "# Setup\nInstall",
					ContentHash: "hash-setup",
				},
			}, nil
		},
	}

	var settledCount int
	outcome := RunIngest(context.Background(), IngestDeps{
		Store:     store,
		Firecrawl: fc,
		Settle: func(_ context.Context, _ string, res SettleResult) error {
			settledCount = res.QueuedDocumentsCount
			return nil
		},
	}, IngestJob{
		ID:     "job-3",
		Owner:  "acme",
		Repo:   "firecrawl-repo",
		UserID: "user-9",
	}, IngestOptions{
		URL:      "http://non-existent-domain-for-fastpath-failure.local",
		MaxPages: 10,
	})

	assert.Equal(t, IngestDone, outcome)
	assert.Equal(t, 2, settledCount)
	assert.Len(t, store.docs, 2)
}

func TestRunIngest_FailClosedWhenBothFail(t *testing.T) {
	store := &fakeIngestStore{}
	fc := &mockFirecrawlAPI{
		crawlFn: func(_ context.Context, _ string, _ int, _ *CrawlFilters) ([]FirecrawlDoc, error) {
			return nil, fmt.Errorf("firecrawl connection refused")
		},
	}

	var errMsg string
	outcome := RunIngest(context.Background(), IngestDeps{
		Store:     store,
		Firecrawl: fc,
		Emit: func(eventType string, payload map[string]any) {
			if eventType == "error" {
				errMsg = fmt.Sprint(payload["message"])
			}
		},
	}, IngestJob{
		ID:    "job-4",
		Owner: "acme",
		Repo:  "failed-repo",
	}, IngestOptions{
		URL:      "http://non-existent-domain.local",
		MaxPages: 5,
	})

	assert.Equal(t, IngestFallback, outcome)
	assert.Contains(t, errMsg, "网页文档抓取失败")
}

func TestIngestProgressReporter_Monotonic(t *testing.T) {
	store := &fakeIngestStore{}
	reporter := newIngestProgressReporter(store, "job-mono", 10*time.Millisecond)

	reporter.Report(context.Background(), "step 1", 30, true)
	time.Sleep(15 * time.Millisecond)
	// Try reporting lower progress
	reporter.Report(context.Background(), "step 2", 20, true)

	store.mu.Lock()
	defer store.mu.Unlock()
	require.Len(t, store.progressLogs, 2)
	assert.Equal(t, 30, store.progressLogs[0].Progress)
	assert.Equal(t, 30, store.progressLogs[1].Progress, "progress must be monotonic")
}

func TestHydrateWebDocOutline_EveDevBlueprintAndOrphans(t *testing.T) {
	topo := &LandingTopology{
		EntryURL:  "https://eve.dev/docs/getting-started",
		SiteTitle: "Eve Documentation",
		SidebarSections: []WebDocSection{
			{
				Title: "Introduction",
				Order: 1,
				Items: []WebDocNavItem{
					{Title: "Getting Started", Href: "/docs/getting-started", Order: 1},
					{Title: "Use Cases", Href: "/docs/use-cases", Order: 2},
				},
			},
			{
				Title: "Build",
				Order: 2,
				Items: []WebDocNavItem{
					{
						Title: "Channels",
						Href:  "/docs/channels",
						Order: 1,
						Children: []WebDocNavItem{
							{Title: "WhatsApp", Href: "/docs/channels/whatsapp", Order: 1},
							{Title: "Telegram", Href: "/docs/channels/telegram", Order: 2},
						},
					},
					{Title: "Extensions", Href: "/docs/extensions", Order: 2},
				},
			},
			{
				Title: "Integrate",
				Order: 3,
				Items: []WebDocNavItem{
					{Title: "Add Integrations", Href: "/docs/add-integrations", Order: 1},
					{Title: "Webhooks", Href: "/docs/webhooks", Order: 2},
				},
			},
		},
	}

	docs := []FirecrawlDoc{
		{Path: "docs/getting-started.md", Title: "Getting Started", URL: "https://eve.dev/docs/getting-started"},
		{Path: "docs/use-cases.md", Title: "Use Cases", URL: "https://eve.dev/docs/use-cases"},
		{Path: "docs/channels/whatsapp.md", Title: "WhatsApp", URL: "https://eve.dev/docs/channels/whatsapp"},
		{Path: "docs/channels/telegram.md", Title: "Telegram", URL: "https://eve.dev/docs/channels/telegram"},
		{Path: "docs/extensions.md", Title: "Extensions", URL: "https://eve.dev/docs/extensions"},
		{Path: "docs/add-integrations.md", Title: "Add Integrations", URL: "https://eve.dev/docs/add-integrations"},
		{Path: "docs/webhooks.md", Title: "Webhooks", URL: "https://eve.dev/docs/webhooks"},
		{Path: "docs/orphan-guide.md", Title: "Orphan Guide", URL: "https://eve.dev/docs/orphan-guide"},
	}

	draft := HydrateWebDocOutline(topo, docs, "https://eve.dev/docs/getting-started")

	// 4 个 Part：Introduction, Build, Integrate, 📎 附录与延伸文档
	require.Len(t, draft.Parts, 4)
	assert.Equal(t, "Introduction", draft.Parts[0].Title)
	assert.Equal(t, 1, draft.Parts[0].TeachingOrder)
	assert.Equal(t, "Build", draft.Parts[1].Title)
	assert.Equal(t, 2, draft.Parts[1].TeachingOrder)
	assert.Equal(t, "Integrate", draft.Parts[2].Title)
	assert.Equal(t, 3, draft.Parts[2].TeachingOrder)
	assert.Equal(t, "📎 附录与延伸文档", draft.Parts[3].Title)
	assert.Equal(t, 4, draft.Parts[3].TeachingOrder)

	// Chapters 顺序检验：首章必须是 Getting Started，教学序必须递进
	require.Len(t, draft.Chapters, 7)

	assert.Equal(t, "Getting Started", draft.Chapters[0].Title)
	assert.Equal(t, 1, draft.Chapters[0].TeachingOrder)
	assert.Equal(t, "Introduction", draft.Chapters[0].PartTitle)
	require.Len(t, draft.Chapters[0].Nodes, 1)
	assert.Equal(t, "docs/getting-started.md", draft.Chapters[0].Nodes[0].SourcePath)

	assert.Equal(t, "Use Cases", draft.Chapters[1].Title)
	assert.Equal(t, 2, draft.Chapters[1].TeachingOrder)
	assert.Equal(t, "Introduction", draft.Chapters[1].PartTitle)

	assert.Equal(t, "Channels", draft.Chapters[2].Title)
	assert.Equal(t, 3, draft.Chapters[2].TeachingOrder)
	assert.Equal(t, "Build", draft.Chapters[2].PartTitle)
	// Channels has 2 child nodes
	require.Len(t, draft.Chapters[2].Nodes, 2)
	assert.Equal(t, "docs/channels/whatsapp.md", draft.Chapters[2].Nodes[0].SourcePath)
	assert.Equal(t, "docs/channels/telegram.md", draft.Chapters[2].Nodes[1].SourcePath)

	assert.Equal(t, "Extensions", draft.Chapters[3].Title)
	assert.Equal(t, 4, draft.Chapters[3].TeachingOrder)
	assert.Equal(t, "Build", draft.Chapters[3].PartTitle)

	assert.Equal(t, "Add Integrations", draft.Chapters[4].Title)
	assert.Equal(t, 5, draft.Chapters[4].TeachingOrder)
	assert.Equal(t, "Integrate", draft.Chapters[4].PartTitle)

	assert.Equal(t, "Webhooks", draft.Chapters[5].Title)
	assert.Equal(t, 6, draft.Chapters[5].TeachingOrder)
	assert.Equal(t, "Integrate", draft.Chapters[5].PartTitle)

	// 孤儿文档落入附录
	assert.Equal(t, "Orphan Guide", draft.Chapters[6].Title)
	assert.Equal(t, 7, draft.Chapters[6].TeachingOrder)
	assert.Equal(t, "📎 附录与延伸文档", draft.Chapters[6].PartTitle)
	assert.Equal(t, "docs/orphan-guide.md", draft.Chapters[6].Nodes[0].SourcePath)
}

func TestRunIngest_StoreOutlineDraftActivated(t *testing.T) {
	store := &fakeIngestStore{}
	fc := &mockFirecrawlAPI{
		crawlFn: func(_ context.Context, _ string, _ int, _ *CrawlFilters) ([]FirecrawlDoc, error) {
			return []FirecrawlDoc{
				{
					Path:        "docs/getting-started.md",
					Title:       "Getting Started",
					Markdown:    "# Getting Started\n\nWelcome.",
					URL:         "https://eve.dev/docs/getting-started",
					ContentHash: "hash1",
				},
				{
					Path:        "docs/integrations.md",
					Title:       "Add Integrations",
					Markdown:    "# Integrations\n\nIntegrate.",
					URL:         "https://eve.dev/docs/integrations",
					ContentHash: "hash2",
				},
			}, nil
		},
	}

	outcome := RunIngest(context.Background(), IngestDeps{
		Store:     store,
		Firecrawl: fc,
	}, IngestJob{
		ID:     "job-outline-tail",
		Owner:  "acme",
		Repo:   "evedev",
		UserID: "user-1",
	}, IngestOptions{
		URL:      "http://non-existent-fastpath-fail.local",
		MaxPages: 5,
	})

	assert.Equal(t, IngestDone, outcome)
	store.mu.Lock()
	defer store.mu.Unlock()

	// 断言 StoreOutlineDraft 被原子调用且 isActive=true
	assert.True(t, store.storedActive, "TutorialOutline must be stored with isActive=true")
	require.NotEmpty(t, store.storedDraft.Chapters, "Stored outline draft must contain chapters")
	assert.Equal(t, "Getting Started", store.storedDraft.Chapters[0].Title)

	// 断言 ProfileJSON 包含 navOrderUrls
	require.NotNil(t, store.upsertRepo)
	var profile map[string]any
	require.NoError(t, json.Unmarshal(store.upsertRepo.ProfileJSON, &profile))
	assert.Contains(t, profile, "navOrderUrls")
}

func TestHydrateWebDocOutline_QueryAndEmptyTitleFallback(t *testing.T) {
	topo := &LandingTopology{
		EntryURL:  "https://eve.dev/docs/intro",
		SiteTitle: "Eve Docs",
		SidebarSections: []WebDocSection{
			{
				Title: "Guide",
				Order: 1,
				Items: []WebDocNavItem{
					{Title: "", Href: "/docs/intro?v=2#start", Order: 1}, // Empty title, query & fragment
				},
			},
		},
	}

	docs := []FirecrawlDoc{
		{
			Path:  "docs/intro.md",
			Title: "Introduction to Eve",
			URL:   "https://eve.dev/docs/intro",
		},
	}

	draft := HydrateWebDocOutline(topo, docs, "https://eve.dev/docs/intro")
	require.Len(t, draft.Chapters, 1)
	assert.Equal(t, "Introduction to Eve", draft.Chapters[0].Title, "empty title must fall back to node title")
	require.Len(t, draft.Chapters[0].Nodes, 1)
	assert.Equal(t, "docs/intro.md", draft.Chapters[0].Nodes[0].SourcePath)
}

type mockIngestProbeLLM struct {
	calls        int
	probeCalls   int
	probePayload string
}

func (m *mockIngestProbeLLM) Generate(_ context.Context, purpose string, _ map[string]any, _ *string, target any) error {
	m.calls++
	if purpose == "webdoc_container_probe" {
		m.probeCalls++
		return json.Unmarshal([]byte(m.probePayload), target)
	}
	return fmt.Errorf("skip non-probe purpose %s", purpose)
}

func TestRunIngest_Phase4ContainerProbeAndImagePersistence(t *testing.T) {
	t.Run("fastpath_triggers_phase4_probe_and_persists_svg_and_telemetry", func(t *testing.T) {
		AllowTestLoopback = true
		t.Cleanup(func() { AllowTestLoopback = false })
		resetRobotsCache()
		t.Cleanup(resetRobotsCache)
		t.Setenv("WEB_CRAWLER_POLITENESS_DELAY_MS", "0")
		tmpAssets := t.TempDir()
		t.Setenv("ASSETS_ROOT", tmpAssets)

		// Include >= 3 anchor degradations (block-anchors containing <table> fail card lift -> degraded quote cards)
		// plus repeated custom div.bento-tile containers and an inline diagram SVG.
		pageHTML := `<!DOCTYPE html><html><head><title>Use Cases</title></head><body><main>
			<h1>Use Cases</h1>
			<p>` + strings.Repeat("Structured engineering workflows and custom bento tiles tested end to end through Go RunIngest. ", 4) + `</p>
			<figure>
				<svg width="640" height="240" viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg">
					<rect x="0" y="0" width="640" height="240" fill="#eee"/>
					<path d="M10 10 L600 200" stroke="#333"/>
					<circle cx="320" cy="120" r="30"/>
				</svg>
				<figcaption>Architecture diagram</figcaption>
			</figure>
			<a href="/docs/fail-1"><h3>Degraded One</h3><div><table><tr><th>A</th><td>1</td></tr></table></div></a>
			<a href="/docs/fail-2"><h3>Degraded Two</h3><div><table><tr><th>B</th><td>2</td></tr></table></div></a>
			<a href="/docs/fail-3"><h3>Degraded Three</h3><div><table><tr><th>C</th><td>3</td></tr></table></div></a>
			<div class="bento-grid">
				<div class="bento-tile"><span class="bento-tag">Workflows</span><div class="bento-heading">Event Workflows</div><p class="bento-desc">Route events cleanly.</p><a class="bento-cta" href="/docs/workflows/events">Explore Events</a></div>
				<div class="bento-tile"><span class="bento-tag">Audit</span><div class="bento-heading">Execution Ledger</div><p class="bento-desc">Trace every run.</p><a class="bento-cta" href="/docs/workflows/ledger">Inspect Ledger</a></div>
			</div>
		</main></body></html>`

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/docs/use-cases" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(pageHTML))
		}))
		defer srv.Close()

		store := &fakeIngestStore{}
		llm := &mockIngestProbeLLM{
			probePayload: `{
				"rules": [
					{
						"containerSelector": "div.bento-tile",
						"role": "card",
						"eyebrowSelector": ".bento-tag",
						"titleSelector": ".bento-heading",
						"bodySelector": ".bento-desc",
						"linkSelector": ".bento-cta"
					}
				]
			}`,
		}

		outcome := RunIngest(context.Background(), IngestDeps{
			Store: store,
			LLM:   llm,
			Settle: func(_ context.Context, _ string, _ SettleResult) error {
				return nil
			},
			BuildNavTree: func(_ []GitNode, _, _ string, _ int) []byte { return []byte("[]") },
		}, IngestJob{
			ID:     "job-p4-fastpath",
			Owner:  "acme",
			Repo:   "bento",
			UserID: "user-1",
		}, IngestOptions{
			URL:      srv.URL + "/docs/use-cases",
			MaxPages: 2,
		})

		assert.Equal(t, IngestDone, outcome)
		assert.Equal(t, 1, llm.probeCalls)
		require.Len(t, store.docs, 1)
		assert.Contains(t, store.docs[0].Content, "<CardGroup")
		assert.Contains(t, store.docs[0].Content, `title="Event Workflows"`)
		assert.Contains(t, store.docs[0].Content, "/api/assets/acme/bento/webimg/")
		assert.NotContains(t, store.docs[0].Content, "data:image/svg+xml;base64,")

		svgFiles, err := filepath.Glob(filepath.Join(tmpAssets, "acme", "bento", "webimg", "*.svg"))
		require.NoError(t, err)
		require.Len(t, svgFiles, 1)
		rawSVG, err := os.ReadFile(svgFiles[0])
		require.NoError(t, err)
		assert.NotContains(t, string(rawSVG), "<script")

		require.NotNil(t, store.upsertRepo)
		// 升维遥测只进进程日志（repoProfile 只写键已按宪章清算），升维效果由上方 CardGroup/资产断言覆盖
	})

	t.Run("firecrawl_crawl_propagates_telemetry_and_triggers_phase4_probe", func(t *testing.T) {
		rawHTML := `<!DOCTYPE html><html><body><main><h1>Firecrawl Bento</h1><p>` +
			strings.Repeat("Firecrawl HTML ingestion carrying rawHtml and DOM lift telemetry into Phase 4 probe replay. ", 4) +
			`</p><div class="bento-grid"><div class="bento-tile"><div class="bento-heading">Queue Runner</div><p class="bento-desc">Runs jobs safely.</p></div><div class="bento-tile"><div class="bento-heading">Event Bus</div><p class="bento-desc">Broadcasts status updates.</p></div></div></main></body></html>`

		store := &fakeIngestStore{}
		llm := &mockIngestProbeLLM{
			probePayload: `{
				"rules": [
					{
						"containerSelector": "div.bento-tile",
						"role": "card",
						"titleSelector": ".bento-heading",
						"bodySelector": ".bento-desc"
					}
				]
			}`,
		}
		fc := &mockFirecrawlAPI{
			crawlFn: func(_ context.Context, _ string, _ int, _ *CrawlFilters) ([]FirecrawlDoc, error) {
				return []FirecrawlDoc{{
					Path:        "docs/bento.md",
					Title:       "Firecrawl Bento",
					Markdown:    "# Firecrawl Bento\n\nPlaceholder text.",
					URL:         "https://example.invalid/docs/bento",
					ContentHash: "fc-hash-1",
					Metadata:    map[string]any{"rawHtml": rawHTML},
					Telemetry: &ContentLiftTelemetry{
						PagesScanned:       1,
						AnchorDegradations: 3,
					},
				}}, nil
			},
		}

		outcome := RunIngest(context.Background(), IngestDeps{
			Store:     store,
			Firecrawl: fc,
			LLM:       llm,
			Settle:    func(_ context.Context, _ string, _ SettleResult) error { return nil },
		}, IngestJob{
			ID:     "job-p4-fc",
			Owner:  "acme",
			Repo:   "fc-bento",
			UserID: "user-1",
		}, IngestOptions{
			URL:      "http://non-existent-domain-for-fastpath-failure.local/docs/bento",
			MaxPages: 5,
		})

		assert.Equal(t, IngestDone, outcome)
		assert.Equal(t, 1, llm.probeCalls)
		require.Len(t, store.docs, 1)
		assert.Contains(t, store.docs[0].Content, "<CardGroup")
		assert.Contains(t, store.docs[0].Content, `title="Queue Runner"`)
		require.NotNil(t, store.upsertRepo)
		assert.Contains(t, store.docs[0].Content, "<CardGroup")
	})
}

func TestExtractWebSiteBrandFromHTML(t *testing.T) {
	tests := []struct {
		name string
		html string
		url  string
		want string
	}{
		{
			name: "prefers og:site_name over generic H1 and page title",
			html: `<html><head><meta property="og:site_name" content="coss ui"><title>Introduction</title></head><body><h1>Introduction</h1></body></html>`,
			url:  "https://coss.com/ui/docs",
			want: "coss ui",
		},
		{
			name: "extracts brand suffix after separator when title is Introduction - Brand",
			html: `<html><head><title>Introduction - coss ui</title></head><body><h1>Introduction</h1></body></html>`,
			url:  "https://coss.com/ui/docs",
			want: "coss ui",
		},
		{
			name: "extracts brand prefix when second part is generic",
			html: `<html><head><title>Eve Docs | Getting Started</title></head><body><h1>Getting Started</h1></body></html>`,
			url:  "https://eve.dev/docs",
			want: "Eve Docs",
		},
		{
			name: "falls back to clean host without www when title is generic Getting Started",
			html: `<html><head><title>Getting Started</title></head><body><h1>Getting Started</h1></body></html>`,
			url:  "https://www.coss.com/ui/docs",
			want: "coss.com",
		},
		{
			name: "ignores generic og:site_name Documentation and falls back to host",
			html: `<html><head><meta property="og:site_name" content="Documentation"><title>Introduction</title></head><body><h1>Introduction</h1></body></html>`,
			url:  "https://docs.example.org/intro",
			want: "docs.example.org",
		},
		{
			name: "rejects page slug title with zero-width anchor char and falls back to host",
			html: "<html><head><title>Features \u200b</title></head><body><h1>Features <a class=\"header-anchor\">\u200b</a></h1></body></html>",
			url:  "https://vite.dev/guide/features",
			want: "vite.dev",
		},
		{
			name: "keeps Vite brand when title has separator even on features page",
			html: "<html><head><title>Features \u200b | Vite</title></head><body><h1>Features \u200b</h1></body></html>",
			url:  "https://vite.dev/guide/features",
			want: "Vite",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractWebSiteBrandFromHTML(tt.html, tt.url)
			assert.Equal(t, tt.want, got)
		})
	}
}
