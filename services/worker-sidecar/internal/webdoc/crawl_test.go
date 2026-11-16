package webdoc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/net/html"
)

type mockLLM struct {
	generateFunc func(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error
}

func (m *mockLLM) Generate(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
	if m.generateFunc != nil {
		return m.generateFunc(ctx, purpose, variables, userId, out)
	}
	return nil
}

func TestDeriveNaturalPrefix(t *testing.T) {
	tests := []struct {
		name     string
		inputURL string
		want     string
	}{
		{
			name:     "eve.dev docs getting started",
			inputURL: "https://eve.dev/docs/getting-started",
			want:     "/docs",
		},
		{
			name:     "eve.dev docs root trailing slash",
			inputURL: "https://eve.dev/docs/",
			want:     "/docs",
		},
		{
			name:     "eve.dev docs bare",
			inputURL: "https://eve.dev/docs",
			want:     "/docs",
		},
		{
			name:     "root domain bare",
			inputURL: "https://eve.dev",
			want:     "/",
		},
		{
			name:     "root domain with slash",
			inputURL: "https://eve.dev/",
			want:     "/",
		},
		{
			name:     "subdomain root",
			inputURL: "https://docs.eve.dev/",
			want:     "/",
		},
		{
			name:     "guide with multi-level path",
			inputURL: "https://framework.org/guide/v2/quickstart",
			want:     "/guide",
		},
		{
			name:     "multilingual site prefix",
			inputURL: "https://site.org/en/docs/intro",
			want:     "/en/docs",
		},
		{
			name:     "single non-doc page defaults to root",
			inputURL: "https://site.org/about-us",
			want:     "/",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := DeriveNaturalPrefix(tt.inputURL)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestHasPathPrefix(t *testing.T) {
	tests := []struct {
		name   string
		path   string
		prefix string
		want   bool
	}{
		{
			name:   "exact match",
			path:   "/docs",
			prefix: "/docs",
			want:   true,
		},
		{
			name:   "child path match",
			path:   "/docs/getting-started",
			prefix: "/docs",
			want:   true,
		},
		{
			name:   "child path match with trailing slash prefix",
			path:   "/docs/getting-started",
			prefix: "/docs/",
			want:   true,
		},
		{
			name:   "boundary safety: does not match partial segment",
			path:   "/docs-other",
			prefix: "/docs",
			want:   false,
		},
		{
			name:   "boundary safety: does not match documentation with docs prefix",
			path:   "/documentation/intro",
			prefix: "/docs",
			want:   false,
		},
		{
			name:   "unrelated path",
			path:   "/changelog",
			prefix: "/docs",
			want:   false,
		},
		{
			name:   "root prefix matches everything",
			path:   "/changelog/page/1",
			prefix: "/",
			want:   true,
		},
		{
			name:   "empty prefix matches everything",
			path:   "/changelog",
			prefix: "",
			want:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := HasPathPrefix(tt.path, tt.prefix)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestIsPaginationURL(t *testing.T) {
	tests := []struct {
		name     string
		rawURL   string
		wantSink bool
	}{
		{
			name:     "changelog page 1",
			rawURL:   "https://eve.dev/changelog/page/1",
			wantSink: true,
		},
		{
			name:     "changelog page 44 with slash",
			rawURL:   "https://eve.dev/changelog/page/44/",
			wantSink: true,
		},
		{
			name:     "short pagination p/3",
			rawURL:   "https://eve.dev/changelog/p/3",
			wantSink: true,
		},
		{
			name:     "query page param",
			rawURL:   "https://eve.dev/changelog?page=2",
			wantSink: true,
		},
		{
			name:     "query p param",
			rawURL:   "https://eve.dev/changelog?foo=bar&p=3",
			wantSink: true,
		},
		{
			name:     "normal doc page",
			rawURL:   "https://eve.dev/docs/getting-started",
			wantSink: false,
		},
		{
			name:     "page name in slug is allowed",
			rawURL:   "https://eve.dev/docs/page-one",
			wantSink: false,
		},
		{
			name:     "pageSize query is not pagination sinkhole",
			rawURL:   "https://eve.dev/docs/search?pageSize=20",
			wantSink: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsPaginationURL(tt.rawURL)
			assert.Equal(t, tt.wantSink, got)
		})
	}
}

func TestExtractLandingTopology(t *testing.T) {
	htmlSample := `
<!DOCTYPE html>
<html>
<head>
    <title>eve - Production AI Agents Documentation</title>
</head>
<body>
    <header>
        <nav>
            <a href="/docs/getting-started">Docs</a>
            <a href="/api">API Reference</a>
            <a href="/changelog">Changelog</a>
            <a href="/benchmarks">Benchmarks</a>
        </nav>
    </header>
    <main>
        <h1>Getting Started</h1>
        <p>Eve helps you build autonomous agents with deterministic state machines.</p>
        <a href="/docs/installation">Installation</a>
        <a href="/docs/config">Configuration</a>
        <a href="/changelog/page/1">Latest Release Notes</a>
        <a href="https://external.com/blog">External Blog</a>
    </main>
</body>
</html>`

	topology := ExtractLandingTopology(htmlSample, "https://eve.dev/docs/getting-started")
	require.NotNil(t, topology)

	assert.Equal(t, "https://eve.dev/docs/getting-started", topology.EntryURL)
	assert.Equal(t, "Getting Started", topology.SiteTitle)

	// Check header links
	assert.NotEmpty(t, topology.HeaderLinks)
	headerHrefs := make([]string, len(topology.HeaderLinks))
	for i, h := range topology.HeaderLinks {
		headerHrefs[i] = h.Href
	}
	assert.Contains(t, headerHrefs, "/docs/getting-started")
	assert.Contains(t, headerHrefs, "/api")
	assert.Contains(t, headerHrefs, "/changelog")
	assert.Contains(t, headerHrefs, "/benchmarks")

	// Check candidate prefixes
	assert.Contains(t, topology.CandidatePrefixes, "/docs")
	assert.Contains(t, topology.CandidatePrefixes, "/api")
	assert.Contains(t, topology.CandidatePrefixes, "/changelog")
	assert.Contains(t, topology.CandidatePrefixes, "/benchmarks")
}

func TestResolveSiteTopologyIntent(t *testing.T) {
	tests := []struct {
		name        string
		topology    *LandingTopology
		llm         LLMGenerator
		wantPrefix  string
		wantTabs    int
		wantExclude int
	}{
		{
			name: "Fast-path short-circuit: single prefix skips LLM entirely",
			topology: &LandingTopology{
				EntryURL:          "https://single.org/docs/intro",
				CandidatePrefixes: []string{"/docs"},
			},
			llm: &mockLLM{
				generateFunc: func(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
					t.Fatalf("LLM should not be called for single candidate prefix")
					return nil
				},
			},
			wantPrefix:  "/docs",
			wantTabs:    0,
			wantExclude: 0,
		},
		{
			name: "Fail-closed fallback: nil LLM gracefully defaults to natural prefix",
			topology: &LandingTopology{
				EntryURL:          "https://eve.dev/docs/getting-started",
				CandidatePrefixes: []string{"/docs", "/changelog", "/benchmarks"},
			},
			llm:         nil,
			wantPrefix:  "/docs",
			wantTabs:    0,
			wantExclude: 0,
		},
		{
			name: "Fail-closed fallback: LLM error gracefully defaults to natural prefix",
			topology: &LandingTopology{
				EntryURL:          "https://eve.dev/docs/getting-started",
				CandidatePrefixes: []string{"/docs", "/changelog", "/benchmarks"},
			},
			llm: &mockLLM{
				generateFunc: func(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
					return errors.New("timeout or model quota exceeded")
				},
			},
			wantPrefix:  "/docs",
			wantTabs:    0,
			wantExclude: 0,
		},
		{
			name: "Successful LLM decision classification",
			topology: &LandingTopology{
				EntryURL:          "https://eve.dev/docs/getting-started",
				CandidatePrefixes: []string{"/docs", "/changelog", "/benchmarks"},
			},
			llm: &mockLLM{
				generateFunc: func(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
					assert.Equal(t, "webdoc_topology_scout", purpose)
					target, ok := out.(*SiteTopologyDecision)
					require.True(t, ok)
					target.PrimaryDocPrefix = "/docs"
					target.ExcludePrefixes = []string{"/changelog", "/benchmarks", "/pricing"}
					target.ModuleTabs = []ModuleTab{
						{ID: "docs", Label: "Docs", Path: "/docs", Kind: "doc"},
						{ID: "api", Label: "API Reference", Path: "/api", Kind: "api"},
						{ID: "changelog", Label: "Changelog", Path: "/changelog", Kind: "changelog"},
					}
					return nil
				},
			},
			wantPrefix:  "/docs",
			wantTabs:    3,
			wantExclude: 3,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			decision := ResolveSiteTopologyIntent(context.Background(), tt.llm, tt.topology, nil)
			require.NotNil(t, decision)
			assert.Equal(t, tt.wantPrefix, decision.PrimaryDocPrefix)
			assert.Equal(t, tt.wantTabs, len(decision.ModuleTabs))
			assert.Equal(t, tt.wantExclude, len(decision.ExcludePrefixes))
		})
	}
}

func TestFastPathCrawlWithOptions_PrefixContainmentAndAntiSinkhole(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)
	t.Setenv("WEB_CRAWLER_POLITENESS_DELAY_MS", "0")

	// 启动局部静态 HTTP 服务模拟带多 Tab 与分页黑洞的站点
	mux := http.NewServeMux()

	bodyText := `<p>Detailed tutorial content explaining everything you need to know about setting up and operating Eve agents in production environments with high availability, robust memory constraints, and continuous monitoring.</p>`

	// 1. Docs 入口与文档页
	mux.HandleFunc("/docs/getting-started", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, staticTestPage("Getting Started", bodyText+`
<a href="/docs/installation">Installation Guide</a>
<a href="/changelog">Changelog</a>
<a href="/changelog/page/1">Changelog Page 1</a>
<a href="/benchmarks">Benchmarks</a>`))
	})

	mux.HandleFunc("/docs/installation", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, staticTestPage("Installation", bodyText+`
<a href="/docs/getting-started">Back</a>`))
	})

	// 2. Changelog 分页黑洞
	mux.HandleFunc("/changelog", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, staticTestPage("Changelog", bodyText+`
<a href="/changelog/page/1">Page 1</a>
<a href="/changelog/page/2">Page 2</a>`))
	})

	mux.HandleFunc("/changelog/page/1", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, staticTestPage("Release Notes v1", bodyText+`
<a href="/changelog/page/2">Next</a>`))
	})

	mux.HandleFunc("/benchmarks", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, staticTestPage("Benchmarks", bodyText))
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	entryURL := srv.URL + "/docs/getting-started"

	// 1. 默认自动前缀收敛（Prefix Containment）
	res := FastPathCrawlWithOptions(context.Background(), entryURL, CrawlOptions{
		MaxPages: 10,
	})
	require.NotNil(t, res)

	// 验证：仅抓取 /docs 下的内容（/docs/getting-started 与 /docs/installation），
	// 彻底杜绝向 /changelog, /changelog/page/* 或 /benchmarks 扩散！
	assert.Equal(t, 2, len(res.Docs))
	paths := []string{res.Docs[0].Path, res.Docs[1].Path}
	for _, p := range paths {
		assert.Contains(t, p, "docs")
		assert.NotContains(t, p, "changelog")
		assert.NotContains(t, p, "benchmarks")
	}

	// 2. 显式 excludePrefixes 拦截
	res2 := FastPathCrawlWithOptions(context.Background(), entryURL, CrawlOptions{
		MaxPages:        10,
		AllowedPrefixes: []string{"/"}, // 即使允许根路径
		ExcludePrefixes: []string{"/changelog", "/benchmarks"},
	})
	require.NotNil(t, res2)
	for _, d := range res2.Docs {
		assert.NotContains(t, d.Path, "changelog")
		assert.NotContains(t, d.Path, "benchmarks")
	}
}

func TestScanFastPathPage_RawHTMLAndFragmentDiscovery(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)

	mux := http.NewServeMux()
	mux.HandleFunc("/docs/intro", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!DOCTYPE html>
<html>
<head><title>Intro Page</title></head>
<body>
<article class="markdown-body">
<h1>Introduction to Eve</h1>
<p>Eve provides deterministic state machines for production agent systems with multi-tenant isolation, cognitive budgeting, and fail-closed security guarantees across distributed environments.</p>
<p>This comprehensive guide walks you through setting up agent topologies, configuring state transitions, and handling edge cases in production traffic seamlessly.</p>
<!-- 纯同页锚点：应该被忽略，不重复入队 -->
<a href="#section-top">Back to top</a>
<!-- 跨页面锚点：必须被成功提取并剥离 hash 入队，不能误杀！ -->
<a href="/docs/guide#prerequisites">Guide Prerequisites</a>
</article>
</body>
</html>`)
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	scan, err := ScanFastPathPage(context.Background(), srv.URL+"/docs/intro", 0)
	require.NoError(t, err)
	require.NotNil(t, scan)
	require.True(t, scan.IsStatic)

	// 1. 验证 rawHtml 正确保留在 ScanResult 与 Document.Metadata 中
	assert.NotEmpty(t, scan.RawHTML)
	assert.Contains(t, scan.RawHTML, "Introduction to Eve")
	require.NotNil(t, scan.Document)
	assert.Equal(t, scan.RawHTML, scan.Document.Metadata["rawHtml"])
	assert.Equal(t, scan.RawHTML, scan.Document.Metadata["html"])

	// 2. 验证跨页锚点链接 (/docs/guide#prerequisites) 成功提纯为 /docs/guide 入队
	require.Len(t, scan.DiscoveredURLs, 1)
	assert.Equal(t, srv.URL+"/docs/guide", scan.DiscoveredURLs[0])
}

func TestExtractLandingTopology_MultilingualAndHeaderPriority(t *testing.T) {
	htmlSample := `<!DOCTYPE html>
<html>
<head><title>Global Platform</title></head>
<body>
<header>
    <nav class="navbar">
        <a href="/en/docs/overview">Documentation</a>
        <a href="/en/api">API Reference</a>
        <a href="/en/changelog">Release Notes</a>
    </nav>
</header>
<aside class="sidebar">
    <nav>
        <a href="/en/docs/sub1">Subpage 1</a>
        <a href="/en/docs/sub2">Subpage 2</a>
        <a href="/en/docs/sub3">Subpage 3</a>
        <a href="/en/docs/sub4">Subpage 4</a>
        <a href="/en/docs/sub5">Subpage 5</a>
        <a href="/en/docs/sub6">Subpage 6</a>
        <a href="/en/docs/sub7">Subpage 7</a>
        <a href="/en/docs/sub8">Subpage 8</a>
        <a href="/en/docs/sub9">Subpage 9</a>
        <a href="/en/docs/sub10">Subpage 10</a>
        <a href="/en/docs/sub11">Subpage 11</a>
        <a href="/en/docs/sub12">Subpage 12</a>
        <a href="/en/docs/sub13">Subpage 13</a>
    </nav>
</aside>
<main>
    <h1>Welcome</h1>
    <p>Main content describing the system.</p>
</main>
</body>
</html>`

	topology := ExtractLandingTopology(htmlSample, "https://global.org/en/docs/overview")
	require.NotNil(t, topology)

	// 1. 验证多语言前缀被正确聚合为二级前缀（如 /en/docs, /en/api, /en/changelog）
	assert.Contains(t, topology.CandidatePrefixes, "/en/docs")
	assert.Contains(t, topology.CandidatePrefixes, "/en/api")
	assert.Contains(t, topology.CandidatePrefixes, "/en/changelog")

	// 2. 验证顶层 Header 链接未被侧边栏的 13 个子页面挤出
	require.NotEmpty(t, topology.HeaderLinks)
	headerTexts := make([]string, 0, len(topology.HeaderLinks))
	for _, hl := range topology.HeaderLinks {
		headerTexts = append(headerTexts, hl.Text)
	}
	assert.Contains(t, headerTexts, "Documentation")
	assert.Contains(t, headerTexts, "API Reference")
	assert.Contains(t, headerTexts, "Release Notes")

	// 3. 三区域分类器：侧栏 13 链接绝不借补进 HeaderLinks（层级坍塌根治）
	assert.NotContains(t, headerTexts, "Subpage 1")
	assert.NotContains(t, headerTexts, "Subpage 13")
	assert.Len(t, topology.HeaderLinks, 3, "header links must contain exactly the top nav, no sidebar backfill")

	// 4. SidebarHeadings 来自侧栏桶（cap 10 截断，非站点总数）
	require.Len(t, topology.SidebarHeadings, 10)
	assert.Equal(t, "Subpage 1", topology.SidebarHeadings[0])
	assert.Equal(t, "Subpage 10", topology.SidebarHeadings[9])

	// 5. candidates 与 HeaderLinks 同源（仅顶栏派生，侧栏子页不贡献 /en/docs 之外的噪声）
	for _, c := range topology.CandidatePrefixes {
		assert.NotContains(t, c, "sub", "sidebar sub-pages must not pollute candidate prefixes")
	}
}

// TestExtractLandingTopology_RegionClassifier 三区域分类器表驱动回归：
// 顶栏(收录开关)与侧栏(章节投影)严格分离，杜绝子章节混入顶层 moduleTabs。
func TestExtractLandingTopology_RegionClassifier(t *testing.T) {
	tests := []struct {
		name            string
		html            string
		entryURL        string
		wantHeaderLinks []string // 期望的 HeaderLinks 文本集合
		wantCandidates  int      // 期望 CandidatePrefixes 数量（0 = sidebar-only 短路语义）
		wantSidebar     []string // 期望 SidebarHeadings 包含项
	}{
		{
			name: "docusaurus shape: navbar + sidebar nav both before main",
			html: `<!DOCTYPE html><html><body>
<div class="wrapper">
  <nav class="navbar"><a href="/docs">Docs</a><a href="/integrations">Integrations</a><a href="/changelog">Changelog</a></nav>
  <nav class="theme-doc-sidebar"><a href="/docs/getting-started">Getting Started</a><a href="/docs/use-cases">Use Cases</a></nav>
  <main><h1>Intro</h1><p>Body content here.</p></main>
</div>
</body></html>`,
			entryURL:        "https://example.org/docs/getting-started",
			wantHeaderLinks: []string{"Docs", "Integrations", "Changelog"},
			wantCandidates:  3,
			wantSidebar:     []string{"Getting Started", "Use Cases"},
		},
		{
			name: "toc nav inside main goes to sidebar bucket",
			html: `<!DOCTYPE html><html><body>
<header><nav><a href="/docs">Docs</a><a href="/api">API</a></nav></header>
<main><h1>Guide</h1><nav aria-label="Table of contents"><a href="/docs/one">Chapter One</a><a href="/docs/two">Chapter Two</a></nav><p>Long content.</p></main>
</body></html>`,
			entryURL:        "https://example.org/docs",
			wantHeaderLinks: []string{"Docs", "API"},
			wantCandidates:  2,
			wantSidebar:     []string{"Chapter One", "Chapter Two"},
		},
		{
			name: "footer nav is ignored entirely",
			html: `<!DOCTYPE html><html><body>
<header><nav><a href="/docs">Docs</a></nav></header>
<main><h1>Guide</h1><p>Content.</p></main>
<footer><nav><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></footer>
</body></html>`,
			entryURL:        "https://example.org/docs",
			wantHeaderLinks: []string{"Docs"},
			wantCandidates:  1,
			wantSidebar:     nil,
		},
		{
			name: "sidebar-only site: header empty, candidates empty (deterministic short-circuit)",
			html: `<!DOCTYPE html><html><body>
<div><nav class="sidebar"><a href="/guide/intro">Introduction</a><a href="/guide/advanced">Advanced</a></nav></div>
<main><h1>Guide</h1><p>Content.</p></main>
</body></html>`,
			entryURL:        "https://example.org/guide/intro",
			wantHeaderLinks: nil,
			wantCandidates:  0,
			wantSidebar:     []string{"Introduction", "Advanced"},
		},
		{
			name: "aria sidebar hint forces sidebar even as first free nav",
			html: `<!DOCTYPE html><html><body>
<nav aria-label="Sidebar"><a href="/docs/a">Section A</a></nav>
<nav><a href="/docs">Docs</a><a href="/api">API</a></nav>
<main><h1>Guide</h1><p>Content.</p></main>
</body></html>`,
			entryURL:        "https://example.org/docs/a",
			wantHeaderLinks: []string{"Docs", "API"},
			wantCandidates:  2,
			wantSidebar:     []string{"Section A"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			topo := ExtractLandingTopology(tt.html, tt.entryURL)
			require.NotNil(t, topo)

			headerTexts := make([]string, 0, len(topo.HeaderLinks))
			for _, hl := range topo.HeaderLinks {
				headerTexts = append(headerTexts, hl.Text)
			}
			if tt.wantHeaderLinks == nil {
				assert.Empty(t, headerTexts)
			} else {
				assert.ElementsMatch(t, tt.wantHeaderLinks, headerTexts)
			}

			assert.Len(t, topo.CandidatePrefixes, tt.wantCandidates)

			for _, want := range tt.wantSidebar {
				assert.Contains(t, topo.SidebarHeadings, want)
			}
			if tt.wantSidebar == nil {
				assert.Empty(t, topo.SidebarHeadings)
			}
		})
	}
}

func TestHasPathPrefix_SlashNormalization(t *testing.T) {
	tests := []struct {
		name   string
		path   string
		prefix string
		want   bool
	}{
		{
			name:   "path missing leading slash",
			path:   "docs/intro",
			prefix: "/docs",
			want:   true,
		},
		{
			name:   "prefix missing leading slash",
			path:   "/docs/intro",
			prefix: "docs",
			want:   true,
		},
		{
			name:   "both missing leading slash",
			path:   "docs/intro",
			prefix: "docs",
			want:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, HasPathPrefix(tt.path, tt.prefix))
		})
	}
}

func TestEffectiveAllowedPrefixes(t *testing.T) {
	tests := []struct {
		name    string
		primary string
		allows  []string
		want    []string
	}{
		{
			name:    "empty scope yields empty union",
			primary: "",
			allows:  nil,
			want:    []string{},
		},
		{
			name:    "primary only (auto path common outcome)",
			primary: "/docs",
			allows:  nil,
			want:    []string{"/docs"},
		},
		{
			name:    "primary union allows with dedup",
			primary: "/docs",
			allows:  []string{"/docs", "/integrations"},
			want:    []string{"/docs", "/integrations"},
		},
		{
			name:    "root primary deduped against identical allow (all-mode allow-everything)",
			primary: "/",
			allows:  []string{"/"},
			want:    []string{"/"},
		},
		{
			name:    "empty strings dropped",
			primary: "/docs",
			allows:  []string{"", "/guide"},
			want:    []string{"/docs", "/guide"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := EffectiveAllowedPrefixes(tt.primary, tt.allows)
			assert.Equal(t, tt.want, got)
		})
	}
}

// TestFastPathCrawlWithOptions_ProgressDenominatorUsesDiscoveredTotal 诚实分母回归：
// 进度分母必须是"已完成+已发现待抓"页数（以 maxPages 封顶），
// 而非预算上限——否则小站（如仅 2 页可抓）在 maxPages=100 下进度永远显示 (2/100)。
func TestFastPathCrawlWithOptions_ProgressDenominatorUsesDiscoveredTotal(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)
	t.Setenv("WEB_CRAWLER_POLITENESS_DELAY_MS", "0")

	bodyText := `<p>Detailed tutorial content explaining everything about deploying agents with high availability, robust memory constraints, continuous monitoring, retry semantics and budget enforcement for production environments every day.</p>`
	mux := http.NewServeMux()
	mux.HandleFunc("/docs/getting-started", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, staticTestPage("Getting Started", bodyText+`<a href="/docs/installation">Installation</a>`))
	})
	mux.HandleFunc("/docs/installation", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, staticTestPage("Installation", bodyText+`<a href="/docs/getting-started">Back</a>`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	var messages []string
	res := FastPathCrawlWithOptions(context.Background(), srv.URL+"/docs/getting-started", CrawlOptions{
		MaxPages: 100, // 预算远大于实际可抓的 2 页
		Emit: func(eventType string, payload map[string]any) {
			if eventType == "log" {
				if msg, ok := payload["message"].(string); ok && strings.Contains(msg, "正在抓取") {
					messages = append(messages, msg)
				}
			}
		},
	})
	require.NotNil(t, res)
	require.Len(t, res.Docs, 2)
	require.NotEmpty(t, messages)

	for _, msg := range messages {
		assert.NotContains(t, msg, "/100)", "denominator must reflect discovered pages, not the maxPages budget")
	}
	// 终态进度应为 (2/2) 而非 (2/100)
	assert.Contains(t, messages[len(messages)-1], "(2/2)")
}

func TestExtractLandingTopology_EveDevSections(t *testing.T) {
	htmlSample := `<!DOCTYPE html>
<html>
<head><title>Eve Documentation</title></head>
<body>
  <header>
    <nav>
      <a href="/docs/getting-started">Docs</a>
      <a href="/api">API Reference</a>
    </nav>
  </header>
  <aside class="sidebar">
    <div class="sidebar-group">
      <h3>Introduction</h3>
      <ul>
        <li><a href="/docs/getting-started">Getting Started</a></li>
        <li><a href="/docs/use-cases">Use Cases</a></li>
      </ul>
    </div>
    <div class="sidebar-group">
      <h3>Build</h3>
      <ul>
        <li>
          <a href="/docs/channels">Channels</a>
          <ul>
            <li><a href="/docs/channels/whatsapp">WhatsApp</a></li>
            <li><a href="/docs/channels/telegram">Telegram</a></li>
          </ul>
        </li>
        <li><a href="/docs/extensions">Extensions</a></li>
      </ul>
    </div>
    <div class="sidebar-group">
      <h3>Integrate</h3>
      <ul>
        <li><a href="/docs/add-integrations">Add Integrations</a></li>
        <li><a href="/docs/webhooks">Webhooks</a></li>
      </ul>
    </div>
  </aside>
  <main>
    <h1>Getting Started</h1>
    <p>Eve helps you build autonomous agents.</p>
  </main>
</body>
</html>`

	topology := ExtractLandingTopology(htmlSample, "https://eve.dev/docs/getting-started")
	require.NotNil(t, topology)

	// 断言提取出 3 个 Part：Introduction, Build, Integrate
	require.Len(t, topology.SidebarSections, 3)

	secIntro := topology.SidebarSections[0]
	assert.Equal(t, "Introduction", secIntro.Title)
	assert.Equal(t, 1, secIntro.Order)
	require.Len(t, secIntro.Items, 2)
	assert.Equal(t, "Getting Started", secIntro.Items[0].Title)
	assert.Equal(t, "/docs/getting-started", secIntro.Items[0].Href)
	assert.Equal(t, 1, secIntro.Items[0].Order)
	assert.Equal(t, "Use Cases", secIntro.Items[1].Title)
	assert.Equal(t, 2, secIntro.Items[1].Order)

	secBuild := topology.SidebarSections[1]
	assert.Equal(t, "Build", secBuild.Title)
	assert.Equal(t, 2, secBuild.Order)
	require.Len(t, secBuild.Items, 2)
	assert.Equal(t, "Channels", secBuild.Items[0].Title)
	require.Len(t, secBuild.Items[0].Children, 2)
	assert.Equal(t, "WhatsApp", secBuild.Items[0].Children[0].Title)
	assert.Equal(t, "Telegram", secBuild.Items[0].Children[1].Title)
	assert.Equal(t, "Extensions", secBuild.Items[1].Title)

	secIntegrate := topology.SidebarSections[2]
	assert.Equal(t, "Integrate", secIntegrate.Title)
	assert.Equal(t, 3, secIntegrate.Order)
	require.Len(t, secIntegrate.Items, 2)
	assert.Equal(t, "Add Integrations", secIntegrate.Items[0].Title)
	assert.Equal(t, "/docs/add-integrations", secIntegrate.Items[0].Href)
	assert.Equal(t, 1, secIntegrate.Items[0].Order)
	assert.Equal(t, "Webhooks", secIntegrate.Items[1].Title)
}

func TestExtractLandingTopology_FlatSidebarFallback(t *testing.T) {
	htmlSample := `<!DOCTYPE html>
<html>
<head><title>Flat Docs Site</title></head>
<body>
  <aside class="sidebar">
    <ul>
      <li><a href="/docs/getting-started">Getting Started</a></li>
      <li><a href="/docs/use-cases">Use Cases</a></li>
      <li><a href="/docs/channels">Channels</a></li>
      <li><a href="/docs/add-integrations">Add Integrations</a></li>
    </ul>
  </aside>
  <main>
    <h1>Getting Started</h1>
  </main>
</body>
</html>`

	topology := ExtractLandingTopology(htmlSample, "https://example.org/docs/getting-started")
	require.NotNil(t, topology)

	// 断言退化为单 Part，保持 DOM 原始物理顺序，绝无字典序倒置
	require.Len(t, topology.SidebarSections, 1)
	sec := topology.SidebarSections[0]
	assert.Equal(t, 1, sec.Order)
	require.Len(t, sec.Items, 4)

	assert.Equal(t, "Getting Started", sec.Items[0].Title)
	assert.Equal(t, 1, sec.Items[0].Order)

	assert.Equal(t, "Use Cases", sec.Items[1].Title)
	assert.Equal(t, 2, sec.Items[1].Order)

	assert.Equal(t, "Channels", sec.Items[2].Title)
	assert.Equal(t, 3, sec.Items[2].Order)

	assert.Equal(t, "Add Integrations", sec.Items[3].Title)
	assert.Equal(t, 4, sec.Items[3].Order)
}

func TestSynthesizeWebDocBlueprint(t *testing.T) {
	flatTopo := &LandingTopology{
		EntryURL:  "https://example.com/docs",
		SiteTitle: "Example Framework",
		SidebarSections: []WebDocSection{
			{
				Title: "Documentation",
				Order: 1,
				Items: []WebDocNavItem{
					{Title: "Intro", Href: "/docs/intro", Order: 1},
					{Title: "Quickstart", Href: "/docs/quickstart", Order: 2},
					{Title: "Architecture", Href: "/docs/arch", Order: 3},
					{Title: "Config", Href: "/docs/config", Order: 4},
					{Title: "Plugins", Href: "/docs/plugins", Order: 5},
					{Title: "Deploy", Href: "/docs/deploy", Order: 6},
					{Title: "CLI", Href: "/docs/cli", Order: 7},
					{Title: "API", Href: "/docs/api", Order: 8},
				},
			},
		},
	}

	t.Run("LLM synthesizes into 3 parts with whitelist enforcement", func(t *testing.T) {
		llm := &mockLLM{
			generateFunc: func(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
				assert.Equal(t, "webdoc_outline_synthesizer", purpose)
				// 模拟 LLM 返回分组，包含一个非法幻觉 URL "/docs/hallucinated"
				rawJSON := `{"sections":[
					{"title":"Getting Started","items":[{"title":"Intro","href":"/docs/intro"},{"title":"Quickstart","href":"/docs/quickstart"},{"title":"Fake","href":"/docs/hallucinated"}]},
					{"title":"Core Guides","items":[{"title":"Architecture","href":"/docs/arch"},{"title":"Config","href":"/docs/config"}]},
					{"title":"Advanced","items":[{"title":"Plugins","href":"/docs/plugins"},{"title":"Deploy","href":"/docs/deploy"},{"title":"CLI","href":"/docs/cli"},{"title":"API","href":"/docs/api"}]}
				]}`
				target := out
				require.NoError(t, json.Unmarshal([]byte(rawJSON), target))
				return nil
			},
		}

		sections := SynthesizeWebDocBlueprint(context.Background(), llm, flatTopo, nil)
		require.Len(t, sections, 3)
		assert.Equal(t, "Getting Started", sections[0].Title)
		assert.Equal(t, 2, len(sections[0].Items), "hallucinated item must be dropped by convergence funnel")
		assert.Equal(t, "Intro", sections[0].Items[0].Title)
		assert.Equal(t, "Quickstart", sections[0].Items[1].Title)

		assert.Equal(t, "Core Guides", sections[1].Title)
		assert.Equal(t, "Advanced", sections[2].Title)
	})

	t.Run("Fail-closed fallback: LLM error gracefully returns original flat sections", func(t *testing.T) {
		llm := &mockLLM{
			generateFunc: func(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
				return errors.New("timeout")
			},
		}

		sections := SynthesizeWebDocBlueprint(context.Background(), llm, flatTopo, nil)
		require.Len(t, sections, 1)
		assert.Equal(t, "Documentation", sections[0].Title)
		assert.Equal(t, 8, len(sections[0].Items))
	})

	t.Run("Orphan parent with children is not duplicated in unplaced recovery", func(t *testing.T) {
		topoWithChildren := &LandingTopology{
			EntryURL:  "https://example.com/docs",
			SiteTitle: "Example Framework",
			SidebarSections: []WebDocSection{
				{
					Title: "Documentation",
					Order: 1,
					Items: []WebDocNavItem{
						{Title: "Intro", Href: "/docs/intro", Order: 1},
						{Title: "Quickstart", Href: "/docs/quickstart", Order: 2},
						{Title: "Arch", Href: "/docs/arch", Order: 3},
						{Title: "Config", Href: "/docs/config", Order: 4},
						{Title: "Deploy", Href: "/docs/deploy", Order: 5},
						{Title: "CLI", Href: "/docs/cli", Order: 6},
						{Title: "API", Href: "/docs/api", Order: 7},
						{
							Title: "Channels",
							Href:  "/docs/channels",
							Order: 8,
							Children: []WebDocNavItem{
								{Title: "WhatsApp", Href: "/docs/channels/whatsapp", Order: 1},
								{Title: "Telegram", Href: "/docs/channels/telegram", Order: 2},
							},
						},
					},
				},
			},
		}

		// LLM places first 7 items, but completely omits "Channels" and its children
		llm := &mockLLM{
			generateFunc: func(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
				rawJSON := `{"sections":[
					{"title":"Core","items":[{"title":"Intro","href":"/docs/intro"},{"title":"Quickstart","href":"/docs/quickstart"},{"title":"Arch","href":"/docs/arch"},{"title":"Config","href":"/docs/config"},{"title":"Deploy","href":"/docs/deploy"},{"title":"CLI","href":"/docs/cli"},{"title":"API","href":"/docs/api"}]}
				]}`
				target := out
				require.NoError(t, json.Unmarshal([]byte(rawJSON), target))
				return nil
			},
		}

		sections := SynthesizeWebDocBlueprint(context.Background(), llm, topoWithChildren, nil)
		require.Len(t, sections, 1)
		// Total items in Core should be 7 + 1 (Channels), NOT 7 + 1 + 2 (duplicated WhatsApp & Telegram)
		require.Len(t, sections[0].Items, 8)
		lastItem := sections[0].Items[7]
		assert.Equal(t, "Channels", lastItem.Title)
		require.Len(t, lastItem.Children, 2)
		assert.Equal(t, "WhatsApp", lastItem.Children[0].Title)
		assert.Equal(t, "Telegram", lastItem.Children[1].Title)
	})
}

func TestExtractLandingTopology_SeparatorAndCategoryKeywords(t *testing.T) {
	htmlSample := `<!DOCTYPE html>
<html>
<head><title>Docs</title></head>
<body>
  <aside class="sidebar">
    <div role="separator">Getting Started</div>
    <ul>
      <li><a href="/docs/welcome">Welcome</a></li>
    </ul>
    <p class="sidebar-separator">Core Concepts</p>
    <ul>
      <li><a href="/docs/concepts">Concepts</a></li>
    </ul>
    <div class="category-title">Integrations</div>
    <ul>
      <li><a href="/docs/integrations">Integrations</a></li>
    </ul>
  </aside>
  <main><h1>Welcome</h1></main>
</body>
</html>`

	topology := ExtractLandingTopology(htmlSample, "https://example.com/docs/welcome")
	require.NotNil(t, topology)
	require.Len(t, topology.SidebarSections, 3)
	assert.Equal(t, "Getting Started", topology.SidebarSections[0].Title)
	assert.Equal(t, "Core Concepts", topology.SidebarSections[1].Title)
	assert.Equal(t, "Integrations", topology.SidebarSections[2].Title)
}

func TestExtractLandingTopology_EveDevRealDOMAndCollapsible(t *testing.T) {
	// 1:1 真实复刻 eve.dev/docs/getting-started 的 <aside> DOM 结构：
	// - 分组标头为无 class 关键词的 <li class="mt-4 flex ... text-label-13"><span>...</span></li>
	// - 折叠目录为 <button aria-expanded="false"><span>Core Concepts</span></button>（不能误判为 Part 分组）
	// - 5 个真实分组：Introduction / Build / Integrate / Operate / Reference
	htmlSample := `<!DOCTYPE html>
<html>
<head><title>Get started with eve</title></head>
<body>
  <header>
    <nav aria-label="Primary navigation">
      <a href="/docs">Docs</a>
      <a href="/integrations">Integrations</a>
    </nav>
  </header>
  <aside class="h-full w-[300px] pr-3 text-gray-900">
    <nav aria-label="Documentation">
      <ul class="m-0 flex list-none flex-col gap-px p-0">
        <li class="mt-4 flex items-center gap-2 px-2 pt-2 pb-1 font-medium text-gray-900 text-label-13 first:mt-0"><span class="min-w-0 truncate">Introduction</span></li>
        <li><div><a href="/docs/getting-started"><span><span>Getting Started</span></span></a></div></li>
        <li><div><a href="/docs/use-cases"><span><span>Use Cases</span></span></a></div></li>
        <li><div><button aria-expanded="false" type="button"><span><span>Core Concepts</span></span></button></div></li>
        <li class="mt-4 flex items-center gap-2 px-2 pt-2 pb-1 font-medium text-gray-900 text-label-13"><span class="min-w-0 truncate">Build</span></li>
        <li><div><a href="/docs/agent-config"><span><span>Agent Configuration</span></span></a></div></li>
        <li><div><a href="/docs/channels"><span><span>Channels</span></span></a><button aria-expanded="false" type="button"><svg></svg></button></div></li>
        <li class="mt-4 flex items-center gap-2 px-2 pt-2 pb-1 font-medium text-gray-900 text-label-13"><span class="min-w-0 truncate">Integrate</span></li>
        <li><div><a href="/docs/install-integrations"><span><span>Add Integrations</span></span></a></div></li>
        <li>
          <div><a href="/docs/extensions"><span><span>Extensions</span></span></a><button aria-expanded="true" type="button"><svg></svg></button></div>
          <ul>
            <li><div><a href="/docs/code-extension">Code Extension</a></div></li>
            <li><div><a href="/docs/guides/self-modification">Self-Modification</a></div></li>
          </ul>
        </li>
        <li class="mt-4 flex items-center gap-2 px-2 pt-2 pb-1 font-medium text-gray-900 text-label-13"><span class="min-w-0 truncate">Operate</span></li>
        <li><div><a href="/docs/evals"><span><span>Evals</span></span></a></div></li>
        <li><div><button aria-expanded="false" type="button"><span><span>Observability</span></span></button></div></li>
        <li class="mt-4 flex items-center gap-2 px-2 pt-2 pb-1 font-medium text-gray-900 text-label-13"><span class="min-w-0 truncate">Reference</span></li>
        <li><div><button aria-expanded="false" type="button"><span><span>Patterns</span></span></button></div></li>
        <li><div><a href="/docs/guides/upgrade"><span><span>Upgrade to 1.0</span></span></a></div></li>
        <li><div><button aria-expanded="false" type="button"><span><span>Reference</span></span></button></div></li>
      </ul>
    </nav>
  </aside>
  <main><h1>Getting Started</h1><p>Welcome to eve durable AI agents in TypeScript.</p></main>
</body>
</html>`

	topology := ExtractLandingTopology(htmlSample, "https://eve.dev/docs/getting-started")
	require.NotNil(t, topology)
	require.Len(t, topology.SidebarSections, 5)

	assert.Equal(t, "Introduction", topology.SidebarSections[0].Title)
	require.Len(t, topology.SidebarSections[0].Items, 3)
	assert.Equal(t, "Getting Started", topology.SidebarSections[0].Items[0].Title)
	assert.Equal(t, "Use Cases", topology.SidebarSections[0].Items[1].Title)
	assert.Equal(t, "Core Concepts", topology.SidebarSections[0].Items[2].Title)
	assert.Equal(t, "", topology.SidebarSections[0].Items[2].Href)

	assert.Equal(t, "Build", topology.SidebarSections[1].Title)
	require.Len(t, topology.SidebarSections[1].Items, 2)
	assert.Equal(t, "Agent Configuration", topology.SidebarSections[1].Items[0].Title)
	assert.Equal(t, "Channels", topology.SidebarSections[1].Items[1].Title)

	assert.Equal(t, "Integrate", topology.SidebarSections[2].Title)
	require.Len(t, topology.SidebarSections[2].Items, 2)
	assert.Equal(t, "Add Integrations", topology.SidebarSections[2].Items[0].Title)
	assert.Equal(t, "Extensions", topology.SidebarSections[2].Items[1].Title)
	require.Len(t, topology.SidebarSections[2].Items[1].Children, 2)

	assert.Equal(t, "Operate", topology.SidebarSections[3].Title)
	require.Len(t, topology.SidebarSections[3].Items, 2)
	assert.Equal(t, "Evals", topology.SidebarSections[3].Items[0].Title)
	assert.Equal(t, "Observability", topology.SidebarSections[3].Items[1].Title)

	assert.Equal(t, "Reference", topology.SidebarSections[4].Title)
	require.Len(t, topology.SidebarSections[4].Items, 3)
	assert.Equal(t, "Patterns", topology.SidebarSections[4].Items[0].Title)
	assert.Equal(t, "Upgrade to 1.0", topology.SidebarSections[4].Items[1].Title)
	assert.Equal(t, "Reference", topology.SidebarSections[4].Items[2].Title)
}

func TestFastPathCrawlWithOptions_FullSiteSidebarMerge(t *testing.T) {
	AllowTestLoopback = true
	defer func() { AllowTestLoopback = false }()

	longText := "This is a comprehensive static documentation article with enough markdown body text to pass the fastpath content length gate easily and reliably. We add additional descriptive sentences about durable execution, channel integrations, and modular agent pipelines so every single page crosses the 250 character threshold."
	mux := http.NewServeMux()
	mux.HandleFunc("/docs/getting-started", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!DOCTYPE html><html><body>
		<aside><nav><ul>
			<li class="mt-4"><span>Introduction</span></li>
			<li><a href="/docs/getting-started">Getting Started</a></li>
			<li><button aria-expanded="false" type="button"><span>Core Concepts</span></button></li>
			<li class="mt-4"><span>Build</span></li>
			<li><a href="/docs/channels">Channels</a><button aria-expanded="false" type="button"></button></li>
		</ul></nav></aside>
		<main><h1>Getting Started</h1><p>%s See <a href="/docs/concepts/execution">Execution</a>.</p></main>
		</body></html>`, longText)
	})
	mux.HandleFunc("/docs/concepts/execution", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!DOCTYPE html><html><body>
		<aside><nav><ul>
			<li class="mt-4"><span>Introduction</span></li>
			<li><a href="/docs/getting-started">Getting Started</a></li>
			<li>
				<div><button aria-expanded="true" type="button"><span>Core Concepts</span></button></div>
				<ul>
					<li><a href="/docs/concepts/execution">Execution Model</a></li>
					<li><a href="/docs/concepts/durability">Durability</a></li>
				</ul>
			</li>
			<li class="mt-4"><span>Build</span></li>
			<li><a href="/docs/channels">Channels</a></li>
		</ul></nav></aside>
		<main><h1>Execution Model</h1><p>%s</p></main>
		</body></html>`, longText)
	})
	mux.HandleFunc("/docs/concepts/durability", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!DOCTYPE html><html><body><main><h1>Durability</h1><p>%s</p></main></body></html>`, longText)
	})
	mux.HandleFunc("/docs/channels", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!DOCTYPE html><html><body>
		<aside><nav><ul>
			<li class="mt-4"><span>Introduction</span></li>
			<li><a href="/docs/getting-started">Getting Started</a></li>
			<li><button aria-expanded="false" type="button"><span>Core Concepts</span></button></li>
			<li class="mt-4"><span>Build</span></li>
			<li>
				<div><a href="/docs/channels">Channels</a><button aria-expanded="true" type="button"></button></div>
				<ul>
					<li><a href="/docs/channels/eve">eve (HTTP &amp; web)</a></li>
					<li><a href="/docs/channels/chat-sdk">Chat SDK</a></li>
				</ul>
			</li>
		</ul></nav></aside>
		<main><h1>Channels</h1><p>%s</p></main>
		</body></html>`, longText)
	})
	mux.HandleFunc("/docs/channels/eve", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!DOCTYPE html><html><body><main><h1>eve (HTTP &amp; web)</h1><p>%s</p></main></body></html>`, longText)
	})
	mux.HandleFunc("/docs/channels/chat-sdk", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!DOCTYPE html><html><body>
		<aside><nav><ul>
			<li class="mt-4"><span>Introduction</span></li>
			<li><a href="/docs/getting-started">Getting Started</a></li>
			<li><button aria-expanded="false" type="button"><span>Core Concepts</span></button></li>
			<li class="mt-4"><span>Build</span></li>
			<li>
				<div><a href="/docs/channels">Channels</a><button aria-expanded="true" type="button"></button></div>
				<ul>
					<li><a href="/docs/channels/eve">eve (HTTP &amp; web)</a></li>
					<li>
						<div><a href="/docs/channels/chat-sdk">Chat SDK</a><button aria-expanded="true" type="button"></button></div>
						<ul>
							<li><a href="/docs/channels/chat-sdk/reference">Chat SDK Reference</a></li>
						</ul>
					</li>
				</ul>
			</li>
		</ul></nav></aside>
		<main><h1>Chat SDK</h1><p>%s</p></main>
		</body></html>`, longText)
	})
	mux.HandleFunc("/docs/channels/chat-sdk/reference", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!DOCTYPE html><html><body><main><h1>Chat SDK Reference</h1><p>%s</p></main></body></html>`, longText)
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	res := FastPathCrawlWithOptions(context.Background(), srv.URL+"/docs/getting-started", CrawlOptions{
		MaxPages:         20,
		PrimaryDocPrefix: "/docs",
	})
	require.Len(t, res.Docs, 7)
	require.Len(t, res.SidebarSections, 2)

	// 验证 Introduction 下 Core Concepts 折叠节点已从子页回填合并
	intro := res.SidebarSections[0]
	assert.Equal(t, "Introduction", intro.Title)
	require.Len(t, intro.Items, 2)
	assert.Equal(t, "Core Concepts", intro.Items[1].Title)
	require.Len(t, intro.Items[1].Children, 2)
	assert.Equal(t, "Execution Model", intro.Items[1].Children[0].Title)
	assert.Equal(t, "Durability", intro.Items[1].Children[1].Title)

	// 验证 Build -> Channels -> Chat SDK -> Chat SDK Reference 三级合并完整且保留 Chat SDK 自身
	build := res.SidebarSections[1]
	assert.Equal(t, "Build", build.Title)
	require.Len(t, build.Items, 1)
	ch := build.Items[0]
	assert.Equal(t, "Channels", ch.Title)
	require.Len(t, ch.Children, 2)
	assert.Equal(t, "eve (HTTP & web)", ch.Children[0].Title)
	assert.Equal(t, "Chat SDK", ch.Children[1].Title)
	require.Len(t, ch.Children[1].Children, 1)
	assert.Equal(t, "Chat SDK Reference", ch.Children[1].Children[0].Title)

	// 验证 HydrateWebDocOutline 落盘后全量 7 篇全部归位且无任何孤儿漏进附录
	draft := HydrateWebDocOutline(&LandingTopology{
		EntryURL:        srv.URL + "/docs/getting-started",
		SidebarSections: res.SidebarSections,
	}, res.Docs, srv.URL+"/docs/getting-started")

	require.Len(t, draft.Parts, 2, "0 orphan docs should leak into an Appendix part")
	require.Len(t, draft.Chapters, 3) // Getting Started, Core Concepts, Channels
	channelsCh := draft.Chapters[2]
	assert.Equal(t, "Channels", channelsCh.Title)
	require.Len(t, channelsCh.Nodes, 4) // Channels + eve + Chat SDK + Chat SDK Reference
	assert.Equal(t, "docs/channels.md", channelsCh.Nodes[0].SourcePath)
	assert.Equal(t, "docs/channels/eve.md", channelsCh.Nodes[1].SourcePath)
	assert.Equal(t, "docs/channels/chat-sdk.md", channelsCh.Nodes[2].SourcePath)
	assert.Equal(t, "docs/channels/chat-sdk/reference.md", channelsCh.Nodes[3].SourcePath)
}

func TestFindMainContentNode_SkipsSVGTitlePseudoText(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)

	svgPseudoTitle := strings.Repeat("VectorDiagramAnnotationWord ", 15)
	realArticle := strings.Repeat("Real documentation content explaining architecture, determinism, and verification gates. ", 5)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = fmt.Fprintf(w, `<!DOCTYPE html><html><body>
<main>
  <svg width="700" height="320" viewBox="0 0 700 320"><title>%s</title><desc>Diagram legend</desc><rect width="700" height="320"/></svg>
  <p>Short shell note.</p>
</main>
<article>
  <h1>Real Documentation Article</h1>
  <p>%s</p>
</article>
</body></html>`, svgPseudoTitle, realArticle)
	}))
	defer srv.Close()

	res, err := ScanFastPathPage(context.Background(), srv.URL+"/docs/architecture", 0)
	require.NoError(t, err)
	require.NotNil(t, res)
	require.True(t, res.IsStatic)
	assert.Contains(t, res.Document.Markdown, "Real Documentation Article")
	assert.Contains(t, res.Document.Markdown, "Real documentation content explaining architecture")
	assert.NotContains(t, res.Document.Markdown, "VectorDiagramAnnotationWord")
}

func TestExtractLandingTopology_MountRootsAndDivNavBlocks(t *testing.T) {
	tests := []struct {
		name           string
		entryURL       string
		html           string
		wantCandidates []string
		wantOutside    int
	}{
		{
			name:     "multi-letter sub-product mount /origin/docs does not collapse like len==2 hack",
			entryURL: "https://acme.com/origin/docs",
			html: `<!DOCTYPE html><html><body>
<header>
  <a href="/origin">Origin</a>
  <nav>
    <a href="/origin/docs">Docs</a>
    <a href="/origin/api">API</a>
    <a href="/origin/changelog">Changelog</a>
  </nav>
</header>
<div class="sidebar-shell">
  <ul>
    <li><a href="/origin/docs">Intro</a></li>
    <li><a href="/origin/docs/setup">Setup</a></li>
    <li><a href="/origin/docs/deploy">Deploy</a></li>
    <li><a href="/origin/docs/faq">FAQ</a></li>
  </ul>
</div>
<main><h1>Origin Docs</h1><p>Guide text.</p></main>
</body></html>`,
			wantCandidates: []string{"/origin", "/origin/docs", "/origin/api", "/origin/changelog"},
			wantOutside:    1,
		},
		{
			name:     "single non-root header link stays 1-segment module root",
			entryURL: "https://single.example.com/docs/getting-started",
			html: `<!DOCTYPE html><html><body>
<header><nav><a href="/docs/getting-started">Docs</a></nav></header>
<main><h1>Getting Started</h1><p>Guide text.</p></main>
</body></html>`,
			wantCandidates: []string{"/docs"},
			wantOutside:    0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			topo := ExtractLandingTopology(tt.html, tt.entryURL)
			require.NotNil(t, topo)
			assert.Equal(t, tt.wantCandidates, topo.CandidatePrefixes)

			outsideCount := 0
			for _, b := range topo.NavBlocks {
				if b.RegionHint == "outside_main" {
					outsideCount++
				}
			}
			assert.Equal(t, tt.wantOutside, outsideCount)
		})
	}
}

func TestExtractSidebarSectionsFromDocWithHints_ThresholdFailClosed(t *testing.T) {
	innerPageHTML := `<!DOCTYPE html><html><body>
<header><nav><a href="/ui/docs">Docs</a><a href="/ui/particles">Particles</a></nav></header>
<div class="layout">
  <div class="custom-panel-without-aside">
    <ul>
      <li><a href="/ui/docs">Introduction</a></li>
      <li><a href="/ui/docs/get-started">Get Started</a></li>
      <li><a href="/ui/docs/styling">Styling</a></li>
      <li><a href="/ui/docs/components/button">Button</a></li>
    </ul>
  </div>
  <main><h1>Button</h1><p>Button docs.</p></main>
</div>
</body></html>`
	doc, err := html.Parse(strings.NewReader(innerPageHTML))
	require.NoError(t, err)

	// Hit: >= requiredOverlap matches outside_main custom div panel cleanly
	sections := ExtractSidebarSectionsFromDocWithHints(doc, "https://coss.com/ui/docs/components/button", "Button", &SidebarTrackHints{
		AnchorHrefs: []string{"/ui/docs", "/ui/docs/get-started", "/ui/docs/styling", "/ui/docs/components/accordion"},
	})
	require.NotEmpty(t, sections)
	assert.Contains(t, collectSectionAnchorHrefs(sections), "/ui/docs/components/button")

	// Cross-module (scope=all switching to Particles where overlap=0 < sidebarTrackMinOverlap):
	// fails closed to empty W3C bucket rather than latching onto header or unrelated panels.
	zeroOverlap := ExtractSidebarSectionsFromDocWithHints(doc, "https://coss.com/ui/particles", "Particles", &SidebarTrackHints{
		AnchorHrefs: []string{"/ui/particles/one", "/ui/particles/two", "/ui/particles/three", "/ui/particles/four"},
	})
	assert.Empty(t, zeroOverlap)
}

func TestSanitizeModuleTabs_EnforcesIngestContract(t *testing.T) {
	longLabel := strings.Repeat("字", 80)
	tabs := sanitizeModuleTabs([]ModuleTab{
		{ID: "", Label: longLabel, Path: "ui/docs/", Kind: "doc"},
		{ID: "dup", Label: "Docs Dup", Path: "/ui/docs", Kind: "doc"},
		{ID: "bad path", Label: "Bad", Path: "/bad path with space", Kind: "doc"},
		{ID: "cl", Label: "Changelog", Path: "/ui/docs/changelog?page=2#top", Kind: "changelog"},
	})
	require.Len(t, tabs, 2)
	assert.LessOrEqual(t, len([]rune(tabs[0].Label)), 64)
	assert.Equal(t, "/ui/docs", tabs[0].Path)
	assert.Equal(t, "/ui/docs/changelog", tabs[1].Path)
	assert.Equal(t, "changelog", tabs[1].Kind)
}
