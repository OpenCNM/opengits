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
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWebDocSSRFProtection(t *testing.T) {
	tests := []struct {
		name      string
		targetURL string
		isPublic  bool
	}{
		{
			name:      "loopback ipv4",
			targetURL: "http://127.0.0.1:8080/docs",
			isPublic:  false,
		},
		{
			name:      "loopback localhost",
			targetURL: "http://localhost:3000/docs",
			isPublic:  false,
		},
		{
			name:      "cloud metadata 169.254.169.254",
			targetURL: "http://169.254.169.254/latest/meta-data/",
			isPublic:  false,
		},
		{
			name:      "private subnet 10.0.0.1",
			targetURL: "http://10.0.0.1/admin",
			isPublic:  false,
		},
		{
			name:      "private subnet 192.168.1.1",
			targetURL: "http://192.168.1.1/secret",
			isPublic:  false,
		},
		{
			name:      "private subnet 172.16.0.1",
			targetURL: "http://172.16.0.1/dashboard",
			isPublic:  false,
		},
		{
			name:      "single label host",
			targetURL: "http://redis:6379/data",
			isPublic:  false,
		},
		{
			name:      "forbidden port 22",
			targetURL: "http://example.com:22/docs",
			isPublic:  false,
		},
		{
			name:      "forbidden port 6379",
			targetURL: "http://example.com:6379/docs",
			isPublic:  false,
		},
		{
			name:      "wildcard dns nip.io 127.0.0.1",
			targetURL: "http://127.0.0.1.nip.io/docs",
			isPublic:  false,
		},
		{
			name:      "wildcard dns sslip.io private",
			targetURL: "http://192-168-1-1.sslip.io/docs",
			isPublic:  false,
		},
		{
			name:      "multicast ipv4 224.0.0.1",
			targetURL: "http://224.0.0.1/docs",
			isPublic:  false,
		},
		{
			name:      "cgnat ipv4 100.64.0.1",
			targetURL: "http://100.64.0.1/docs",
			isPublic:  false,
		},
		{
			name:      "valid public domain",
			targetURL: "https://example.com/docs",
			isPublic:  true,
		},
		{
			name:      "valid public subdomain",
			targetURL: "https://docs.astro.build/en/getting-started",
			isPublic:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsPublicEndpoint(tt.targetURL)
			assert.Equal(t, tt.isPublic, got, "SSRF check mismatch for URL: %s", tt.targetURL)
		})
	}
}

func TestWebDocDiffLogic(t *testing.T) {
	t.Run("ParseSitemapXML <urlset> 流式解析", func(t *testing.T) {
		xmlData := `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/docs/intro</loc>
    <lastmod>2026-01-01</lastmod>
  </url>
  <url>
    <loc>https://example.com/docs/guide</loc>
    <lastmod>2026-02-01</lastmod>
  </url>
</urlset>`

		urls, childSitemaps, err := ParseSitemapXML(strings.NewReader(xmlData))
		require.NoError(t, err)
		assert.Empty(t, childSitemaps)
		assert.Equal(t, 2, len(urls))
		assert.Equal(t, "2026-01-01", urls["https://example.com/docs/intro"])
		assert.Equal(t, "2026-02-01", urls["https://example.com/docs/guide"])
	})

	t.Run("ParseSitemapXML <sitemapindex> 两级索引解析", func(t *testing.T) {
		xmlIndex := `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sub-sitemap-1.xml</loc>
    <lastmod>2026-03-01</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sub-sitemap-2.xml</loc>
  </sitemap>
</sitemapindex>`

		urls, childSitemaps, err := ParseSitemapXML(strings.NewReader(xmlIndex))
		require.NoError(t, err)
		assert.Empty(t, urls)
		assert.Equal(t, 2, len(childSitemaps))
		assert.Equal(t, "https://example.com/sub-sitemap-1.xml", childSitemaps[0])
		assert.Equal(t, "https://example.com/sub-sitemap-2.xml", childSitemaps[1])
	})

	t.Run("ComputeWebDocDiff 三向增量比对", func(t *testing.T) {
		tests := []struct {
			name        string
			currentUrls map[string]string
			prevSitemap map[string]string
			newEtag     string
			rootURL     string
			wantAdd     []string
			wantUpdate  []string
			wantRemove  []string
			wantChanged int
			wantHas     bool
		}{
			{
				name: "add, update, remove 组合",
				currentUrls: map[string]string{
					"https://x.com/a":   "2026-01-01",
					"https://x.com/b":   "2026-02-02",
					"https://x.com/new": "2026-03-03",
				},
				prevSitemap: map[string]string{
					"https://x.com/a":    "2026-01-01",
					"https://x.com/b":    "2026-01-01",
					"https://x.com/gone": "2025-12-01",
				},
				newEtag:     `W/"etag-1"`,
				rootURL:     "https://x.com",
				wantAdd:     []string{"https://x.com/new"},
				wantUpdate:  []string{"https://x.com/b"},
				wantRemove:  []string{"https://x.com/gone"},
				wantChanged: 3,
				wantHas:     true,
			},
			{
				name: "零变更完全一致",
				currentUrls: map[string]string{
					"https://x.com/a": "2026-01-01",
				},
				prevSitemap: map[string]string{
					"https://x.com/a": "2026-01-01",
				},
				newEtag:     `W/"etag-same"`,
				rootURL:     "https://x.com",
				wantAdd:     []string{},
				wantUpdate:  []string{},
				wantRemove:  []string{},
				wantChanged: 0,
				wantHas:     false,
			},
			{
				name:        "空 sitemap 回落 rootUrl",
				currentUrls: map[string]string{},
				prevSitemap: map[string]string{},
				newEtag:     "",
				rootURL:     "https://x.com/docs",
				wantAdd:     []string{"https://x.com/docs"},
				wantUpdate:  []string{},
				wantRemove:  []string{},
				wantChanged: 1,
				wantHas:     true,
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				res := ComputeWebDocDiff(tt.currentUrls, tt.prevSitemap, tt.newEtag, tt.rootURL)
				assert.Equal(t, tt.wantHas, res.HasChanges)
				assert.Equal(t, tt.wantChanged, res.TotalChanged)
				assert.Equal(t, tt.wantAdd, res.PagesToAdd)
				assert.Equal(t, tt.wantUpdate, res.PagesToUpdate)
				assert.Equal(t, tt.wantRemove, res.PagesToRemove)
			})
		}
	})
}

// TestHandleTopology HTTP 级拓扑探测端点表驱动测试：
// 多 Tab 裁决透传 / LLM 失效封闭 / 无 LLM 确定性短路 / 入参校验。
func TestHandleTopology(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)
	resetSeedTopologyCache()
	t.Cleanup(resetSeedTopologyCache)
	t.Setenv("WEB_CRAWLER_POLITENESS_DELAY_MS", "0")

	// 模拟真实文档站结构：<header> 内一级 Tab（Docs/Integrations/Changelog）+
	// <main> 内 TOC nav（章节预览，三区域分类器归侧栏桶）+ 长正文。
	// （旧 fixture 经 staticTestPage 把 nav 注入 <main> 内——恰是被分类器
	// 根治的污染形态，故弃用）
	landingHTML := `<!DOCTYPE html>
<html>
<head><title>Eve Docs</title></head>
<body>
<header>
  <nav>
    <a href="/docs/getting-started">Docs</a>
    <a href="/integrations">Integrations</a>
    <a href="/changelog">Changelog</a>
  </nav>
</header>
<main>
  <h1>Getting Started</h1>
  <nav aria-label="Table of contents">
    <a href="/docs/use-cases">Use Cases</a>
    <a href="/docs/instructions">Instructions</a>
  </nav>
  <p>Long-form tutorial content about agent orchestration, memory constraints, and production monitoring with high availability guarantees. This guide walks through the complete lifecycle of deploying, scaling and operating autonomous agents in production environments, covering retry semantics, budget enforcement, observability dashboards, incident response playbooks and capacity planning worksheets used by platform teams every single day.</p>
</main>
</body>
</html>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, landingHTML)
	}))
	defer srv.Close()
	entryURL := srv.URL + "/docs/getting-started"

	decisionLLM := &mockLLM{generateFunc: func(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
		require.Equal(t, "webdoc_topology_scout", purpose)
		if userId == nil {
			return errors.New("userId must be forwarded for BYOK gateway resolution")
		}
		d, ok := out.(*SiteTopologyDecision)
		require.True(t, ok)
		d.PrimaryDocPrefix = "/docs"
		d.ExcludePrefixes = []string{"/changelog"}
		d.ModuleTabs = []ModuleTab{
			{ID: "docs", Label: "Docs", Path: "/docs", Kind: "doc"},
			{ID: "integrations", Label: "Integrations", Path: "/integrations", Kind: "doc"},
			{ID: "changelog", Label: "Changelog", Path: "/changelog", Kind: "changelog"},
		}
		return nil
	}}

	tests := []struct {
		name       string
		body       string
		llm        LLMGenerator
		wantStatus int
		check      func(t *testing.T, resp TopologyResponse)
	}{
		{
			name:       "multi-tab decision round-trips with forwarded userId",
			body:       `{"url":"` + entryURL + `","userId":"u1"}`,
			llm:        decisionLLM,
			wantStatus: http.StatusOK,
			check: func(t *testing.T, resp TopologyResponse) {
				assert.Equal(t, "multi_module", resp.ScoutStatus)
				assert.Equal(t, "/docs", resp.PrimaryDocPrefix)
				assert.Equal(t, "/docs", resp.NaturalPrefix)
				// ExtractWebPageTitle 契约:非导航 h1 优先于 <title>(fastpath.go:111)
				assert.Equal(t, "Getting Started", resp.SiteTitle)
				require.Len(t, resp.ModuleTabs, 3)
				assert.Equal(t, []string{"/changelog"}, resp.ExcludePrefixes)
				// 章节预览来自 <main> 内 TOC nav（侧栏桶），顶栏 Tab 文本绝不混入
				assert.Contains(t, resp.SidebarHeadings, "Use Cases")
				assert.Contains(t, resp.SidebarHeadings, "Instructions")
				assert.NotContains(t, resp.SidebarHeadings, "Integrations")
				assert.NotContains(t, resp.SidebarHeadings, "Changelog")
			},
		},
		{
			name: "llm failure preserves deterministic fallback tabs from HeaderLinks",
			body: `{"url":"` + entryURL + `","userId":"u1"}`,
			llm: &mockLLM{generateFunc: func(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
				return errors.New("gateway 502")
			}},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, resp TopologyResponse) {
				assert.Equal(t, "/docs", resp.PrimaryDocPrefix)
				assert.Equal(t, "multi_module", resp.ScoutStatus)
				require.Len(t, resp.ModuleTabs, 3)
			},
		},
		{
			name:       "nil llm synthesizes fallback tabs from HeaderLinks",
			body:       `{"url":"` + entryURL + `","userId":"u1"}`,
			llm:        nil,
			wantStatus: http.StatusOK,
			check: func(t *testing.T, resp TopologyResponse) {
				assert.Equal(t, "/docs", resp.PrimaryDocPrefix)
				assert.Equal(t, "multi_module", resp.ScoutStatus)
				require.Len(t, resp.ModuleTabs, 3)
			},
		},
		{
			name:       "missing url rejected 400",
			body:       `{"userId":"u1"}`,
			llm:        decisionLLM,
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetSeedTopologyCache()
			h := NewTopologyHandler(tt.llm)
			req := httptest.NewRequest(http.MethodPost, "/v1/web-doc/topology", strings.NewReader(tt.body))
			rec := httptest.NewRecorder()
			h.HandleTopology(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.check == nil {
				return
			}
			var resp TopologyResponse
			require.NoError(t, json.NewDecoder(rec.Body).Decode(&resp))
			tt.check(t, resp)
		})
	}
}

func TestHandleTopology_ScanFailedAndDivSidebarWithCache(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)
	resetSeedTopologyCache()
	t.Cleanup(resetSeedTopologyCache)
	t.Setenv("WEB_CRAWLER_POLITENESS_DELAY_MS", "0")

	cossLikeHTML := `<!DOCTYPE html><html><head><title>Introduction - coss ui</title></head><body>
<header>
  <a href="/ui">coss.com ui</a>
  <nav>
    <a href="/ui/docs">Docs</a>
    <a href="/ui/particles">Particles</a>
    <a href="/ui/chat">Chat UI</a>
  </nav>
</header>
<div class="shell">
  <div class="sidebar-shell" data-slot="sidebar-content">
    <div data-slot="sidebar-group">
      <div data-slot="sidebar-group-label">Overview</div>
      <ul>
        <li><a href="/ui/docs">Introduction</a></li>
        <li><a href="/ui/docs/get-started">Get Started</a></li>
        <li><a href="/ui/docs/styling">Styling</a></li>
      </ul>
    </div>
    <div data-slot="sidebar-group">
      <div data-slot="sidebar-group-label">Components</div>
      <ul>
        <li><a href="/ui/docs/components/accordion">Accordion</a></li>
        <li><a href="/ui/docs/components/button">Button</a></li>
      </ul>
    </div>
  </div>
  <main>
    <h1>Introduction</h1>
    <p>` + strings.Repeat("A modern UI component library built on Base UI with accessible primitives, tokens, and keyboard navigation patterns for real production interfaces. ", 4) + `</p>
  </main>
</div>
</body></html>`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ui/docs":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = fmt.Fprint(w, cossLikeHTML)
		case "/robots.txt":
			w.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprintf(w, "User-agent: *\nAllow: /\nSitemap: %s/sitemap.xml\nSitemap: %s/ui/sitemap.xml\nSitemap: %s/origin/sitemap.xml\n", "http://"+r.Host, "http://"+r.Host, "http://"+r.Host)
		case "/ui/sitemap.xml":
			w.Header().Set("Content-Type", "application/xml")
			_, _ = fmt.Fprintf(w, `<?xml version="1.0"?><urlset><url><loc>http://%s/ui/docs/get-started</loc><lastmod>2026-11-01</lastmod></url></urlset>`, r.Host)
		case "/origin/sitemap.xml":
			t.Fatalf("unexpected fetch to unrelated /origin/sitemap.xml")
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	t.Run("scan_failed reported explicitly on 404 page", func(t *testing.T) {
		h := NewTopologyHandler(nil)
		req := httptest.NewRequest(http.MethodPost, "/v1/web-doc/topology", strings.NewReader(`{"url":"`+srv.URL+`/missing-page"}`))
		rec := httptest.NewRecorder()
		h.HandleTopology(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp TopologyResponse
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&resp))
		assert.Equal(t, "scan_failed", resp.ScoutStatus)
		assert.NotEmpty(t, resp.FailureReason)
	})

	t.Run("div sidebar resolved by LLM sidebarBlockId populates headings and joint cache", func(t *testing.T) {
		resetSeedTopologyCache()
		llmCalls := 0
		llm := &mockLLM{generateFunc: func(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
			llmCalls++
			blocks, ok := variables["navBlocks"].([]map[string]any)
			require.True(t, ok)
			var outsideID string
			for _, b := range blocks {
				if b["regionHint"] == "outside_main" {
					outsideID, _ = b["id"].(string)
				}
			}
			require.NotEmpty(t, outsideID)
			d := out.(*SiteTopologyDecision)
			d.PrimaryDocPrefix = "/ui/docs"
			d.SidebarBlockID = outsideID
			d.ModuleTabs = []ModuleTab{
				{ID: "docs", Label: "Docs", Path: "/ui/docs", Kind: "doc"},
				{ID: "particles", Label: "Particles", Path: "/ui/particles", Kind: "doc"},
				{ID: "chat", Label: "Chat UI", Path: "/ui/chat", Kind: "doc"},
			}
			return nil
		}}

		entryURL := srv.URL + "/ui/docs"
		h := NewTopologyHandler(llm)
		req := httptest.NewRequest(http.MethodPost, "/v1/web-doc/topology", strings.NewReader(`{"url":"`+entryURL+`"}`))
		rec := httptest.NewRecorder()
		h.HandleTopology(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp TopologyResponse
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&resp))
		assert.Equal(t, "multi_module", resp.ScoutStatus)
		assert.Equal(t, "/ui/docs", resp.PrimaryDocPrefix)
		assert.Len(t, resp.ModuleTabs, 3)
		assert.Contains(t, resp.SidebarHeadings, "Get Started")
		assert.Contains(t, resp.SidebarHeadings, "Accordion")
		assert.NotContains(t, resp.SidebarHeadings, "Particles")

		// 验证联合缓存已存储 SeedScan + Decision 且第二次非 bypass 请求直接复用不重调 LLM
		cached := seedTopoCache.Get(entryURL)
		require.NotNil(t, cached)
		require.NotNil(t, cached.decision)
		assert.NotEmpty(t, cached.decision.ResolvedSidebarSections)
		assert.Contains(t, cached.decision.SidebarAnchorHrefs, "/ui/docs/get-started")

		req2 := httptest.NewRequest(http.MethodPost, "/v1/web-doc/topology", strings.NewReader(`{"url":"`+entryURL+`"}`))
		rec2 := httptest.NewRecorder()
		h.HandleTopology(rec2, req2)
		assert.Equal(t, 1, llmCalls, "second scout call should hit joint seedTopoCache")
	})

	t.Run("sitemap discovery follows robots.txt longest matching prefix", func(t *testing.T) {
		diff, err := DetectWebDocDiff(context.Background(), srv.URL+"/ui/docs", "", nil, 5*time.Second)
		require.NoError(t, err)
		require.True(t, diff.HasChanges)
		assert.Equal(t, []string{srv.URL + "/ui/docs/get-started"}, diff.PagesToAdd)
	})
}

func TestSeedTopologyCache_BoundsAndNormalization(t *testing.T) {
	resetSeedTopologyCache()
	t.Cleanup(resetSeedTopologyCache)

	scan := &FastPathScanResult{
		IsStatic: true,
		RawHTML:  "<html><body><main>hi</main></body></html>",
		Document: &FastPathDocument{Title: "UI"},
	}
	topo := &LandingTopology{EntryURL: "https://coss.com/ui/docs"}
	dec := &SiteTopologyDecision{PrimaryDocPrefix: "/ui/docs"}

	seedTopoCache.Set("HTTPS://COSS.COM/ui/docs/#intro", scan, topo, dec)
	hit := seedTopoCache.Get("https://coss.com/ui/docs")
	require.NotNil(t, hit, "cache key must normalize scheme/host case, fragment, and trailing slash")
	assert.Equal(t, "/ui/docs", hit.decision.PrimaryDocPrefix)

	// 超大 RawHTML (>4MB) 仅缓结构而不扣留原文大串
	hugeScan := &FastPathScanResult{
		IsStatic: true,
		RawHTML:  strings.Repeat("a", seedCacheSingleRawMaxSize+1024),
		Document: &FastPathDocument{Title: "Huge"},
	}
	seedTopoCache.Set("https://coss.com/huge/docs", hugeScan, topo, dec)
	hugeHit := seedTopoCache.Get("https://coss.com/huge/docs")
	require.NotNil(t, hugeHit)
	assert.Empty(t, hugeHit.seedScan.RawHTML)
	assert.Equal(t, 0, hugeHit.rawBytes)
}
