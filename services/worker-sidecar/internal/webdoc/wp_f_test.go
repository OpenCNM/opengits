package webdoc

import (
	"sync"

	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/net/html"
	"golang.org/x/text/encoding/simplifiedchinese"
)

// ─────────────────────────────────────────────────────────────
// WP-F：robots 合规 / fast-path BFS 梯 / Content-Type 门与 charset /
// 规范路径百分号保真 / 同源图片持久化
// ─────────────────────────────────────────────────────────────

func TestParseRobotsForUA(t *testing.T) {
	// robotstxt 下沉后以 `*` 组行为判定取代内部模式清单断言
	tests := []struct {
		name   string
		robots string
		path   string
		want   bool
	}{
		{
			name:   "star group enforced, other UA groups ignored",
			robots: "User-agent: Googlebot\nDisallow: /g/\n\nUser-agent: *\nDisallow: /private/\nAllow: /private/public/",
			path:   "/private/page",
			want:   false,
		},
		{
			name:   "longer allow rule wins over shorter disallow",
			robots: "User-agent: Googlebot\nDisallow: /g/\n\nUser-agent: *\nDisallow: /private/\nAllow: /private/public/",
			path:   "/private/public/index",
			want:   true,
		},
		{
			name:   "non-grouped paths unaffected",
			robots: "User-agent: Googlebot\nDisallow: /g/\n\nUser-agent: *\nDisallow: /private/\nAllow: /private/public/",
			path:   "/docs/intro",
			want:   true,
		},
		{
			name:   "other UA group never applies to star crawler",
			robots: "User-agent: Googlebot\nDisallow: /g/\n\nUser-agent: *\nDisallow: /private/\nAllow: /private/public/",
			path:   "/g/page",
			want:   true,
		},
		{
			name:   "comments and blank rules ignored",
			robots: "# comment\nUser-agent: * # trailing\nDisallow:  \nDisallow: /admin # x",
			path:   "/admin",
			want:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rules := parseRobotsForUA(tt.robots)
			require.NotNil(t, rules)
			assert.Equal(t, tt.want, rules.data.TestAgent(tt.path, "*"))
		})
	}
}

func TestIsUrlAllowedByRobots(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)
	t.Setenv("WEB_CRAWLER_RESPECT_ROBOTS", "")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/robots.txt" {
			_, _ = w.Write([]byte("User-agent: *\nDisallow: /private/\nAllow: /private/public/\nDisallow: /secret$"))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)

	tests := []struct {
		path string
		want bool
	}{
		{"/docs/intro", true},
		{"/private/page", false},        // Disallow 命中且无更长 Allow
		{"/private/public/index", true}, // Allow 更长前缀胜出（平局/更长 Allow）
		{"/secret", false},              // $ 锚定全匹配
		{"/secret-extra", true},         // $ 锚定不命中前缀
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			resetRobotsCache()
			got := IsUrlAllowedByRobots(context.Background(), srv.URL+tt.path)
			assert.Equal(t, tt.want, got)
		})
	}

	t.Run("respect switch off allows everything", func(t *testing.T) {
		t.Setenv("WEB_CRAWLER_RESPECT_ROBOTS", "false")
		defer t.Setenv("WEB_CRAWLER_RESPECT_ROBOTS", "")
		resetRobotsCache()
		assert.True(t, IsUrlAllowedByRobots(context.Background(), srv.URL+"/private/page"))
	})

	t.Run("missing robots fails open", func(t *testing.T) {
		empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.NotFound(w, r0())
		}))
		t.Cleanup(empty.Close)
		resetRobotsCache()
		assert.True(t, IsUrlAllowedByRobots(context.Background(), empty.URL+"/private/page"))
	})
}

func r0() *http.Request {
	req, _ := http.NewRequest(http.MethodGet, "/x", nil)
	return req
}

func TestNormalizeCrawlURL(t *testing.T) {
	tests := []struct {
		raw  string
		want string
	}{
		{"https://x.com/a", "https://x.com/a"},
		{"https://x.com/a/", "https://x.com/a"},
		{"https://x.com/", "https://x.com/"}, // path 长度 1 不剥尾斜杠（Node 语义）
		{"https://x.com/a?b=1#frag", "https://x.com/a?b=1"},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			assert.Equal(t, tt.want, normalizeCrawlURL(tt.raw))
		})
	}
}

func TestCanonicalDocPathFromUrlParity(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{"root becomes index", "https://x.com/", "index.md"},
		{"single trailing slash trimmed once", "https://x.com/a/", "a.md"},
		{"plain path", "https://x.com/docs/intro", "docs/intro.md"},
		{"percent-encoding preserved (Node URL.pathname semantics)", "https://x.com/docs/%E4%B8%AD%E6%96%87/", "docs/%E4%B8%AD%E6%96%87.md"},
		{"unicode path encodes to percent form", "https://x.com/中文/", "%E4%B8%AD%E6%96%87.md"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, CanonicalDocPathFromUrl(tt.raw))
		})
	}
}

func staticTestPage(title string, body string) string {
	return fmt.Sprintf(`<!DOCTYPE html><html><head><title>%s</title></head><body><main><h1>%s</h1>%s</main></body></html>`, title, title, body)
}

func TestFastPathCrawlBFS(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)
	t.Setenv("WEB_CRAWLER_POLITENESS_DELAY_MS", "0")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			_, _ = w.Write([]byte(staticTestPage("Home", `<p>Intro text long enough to pass minimum extraction thresholds with plenty of details about the site, its purpose, the intended audience, and the overall structure of the documentation being published here.</p><a href="/a.html">A</a> <a href="/b.html">B</a>`)))
		case "/a.html":
			_, _ = w.Write([]byte(staticTestPage("Page A", `<p>Page A body content describing topic A in enough depth for extraction heuristics to accept, covering background, core concepts, worked examples, common pitfalls, and a short summary of what readers should take away from this section of the guide.</p><a href="/b.html">B</a>`)))
		case "/b.html":
			_, _ = w.Write([]byte(staticTestPage("Page B", `<p>Page B body content describing topic B in enough depth for extraction heuristics to accept, covering background, core concepts, worked examples, common pitfalls, and a short summary of what readers should take away from this section of the guide.</p>`)))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	res := FastPathCrawlWithOptions(context.Background(), srv.URL+"/", CrawlOptions{MaxPages: 10})
	require.NotEmpty(t, res.Docs, "static site must be crawled via fast-path BFS")
	titles := map[string]bool{}
	for _, d := range res.Docs {
		titles[d.Title] = true
		assert.Equal(t, "fast-path", d.Metadata["engine"])
	}
	assert.True(t, titles["Home"])
	assert.True(t, titles["Page A"])
	assert.True(t, titles["Page B"])

	t.Run("maxPages caps the crawl", func(t *testing.T) {
		capped := FastPathCrawlWithOptions(context.Background(), srv.URL+"/", CrawlOptions{MaxPages: 2})
		assert.Len(t, capped.Docs, 2)
	})

	t.Run("non-static entry returns empty for Firecrawl fallback", func(t *testing.T) {
		jsonSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"api":true}`))
		}))
		t.Cleanup(jsonSrv.Close)
		empty := FastPathCrawlWithOptions(context.Background(), jsonSrv.URL+"/", CrawlOptions{MaxPages: 10})
		assert.Empty(t, empty.Docs)
	})
}

func TestFastPathCharsetDecoding(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)

	htmlText := staticTestPage("中文文档标题", strings.Repeat("<p>这是一段用于验证 GBK 编码解码的中文正文内容，需要足够长以通过正文提取的最小长度校验。</p>", 6))
	gbkBytes, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte(htmlText))
	require.NoError(t, err)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=GBK")
		_, _ = w.Write(gbkBytes)
	}))
	t.Cleanup(srv.Close)

	res, err := ScanFastPathPage(context.Background(), srv.URL+"/", 0)
	require.NoError(t, err)
	require.NotNil(t, res)
	require.True(t, res.IsStatic, "GBK page must be decoded and accepted")
	require.NotNil(t, res.Document)
	assert.Contains(t, res.Document.Title, "中文文档标题", "declared charset must be honored (no mojibake)")
	assert.Contains(t, res.Document.Markdown, "中文正文内容")
}

func TestFastPathContentTypeGate(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"not":"html"}`))
	}))
	t.Cleanup(srv.Close)

	res, err := ScanFastPathPage(context.Background(), srv.URL+"/api/data", 0)
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.False(t, res.IsStatic, "non-HTML content-type must be rejected")
}

func TestPersistSameOriginImages(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })

	pngBytes := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 1, 2, 3, 4}
	var requestPathMu sync.Mutex
	var requestPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestPathMu.Lock()
		requestPath = r.URL.Path
		requestPathMu.Unlock()
		switch r.URL.Path {
		case "/img/a.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		case "/img/huge.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(make([]byte, imgMaxBytes+10))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	assets := t.TempDir()
	t.Setenv("ASSETS_ROOT", assets)

	docs := []FirecrawlDoc{
		{
			Path:        "index.md",
			Title:       "Index",
			URL:         srv.URL + "/index.html",
			Markdown:    "# Index\n\n![logo](/img/a.png) 同源图会重写；![ext](https://other-cdn.example.com/x.png) 跨源不动；![huge](/img/huge.png) 超限跳过。",
			ContentHash: "old",
		},
	}
	out := PersistSameOriginImages(context.Background(), "own", "rep", docs, srv.URL+"/")
	require.Len(t, out, 1)
	assert.Contains(t, out[0].Markdown, "/api/assets/own/rep/webimg/", "same-origin image must be rewritten to local asset path")
	assert.Contains(t, out[0].Markdown, "https://other-cdn.example.com/x.png", "cross-origin image must stay untouched")
	assert.NotContains(t, out[0].Markdown, "](/img/a.png)", "original same-origin link must be replaced")
	assert.NotEqual(t, "old", out[0].ContentHash, "contentHash must be recomputed after rewrite")

	// 落盘校验
	entries, err := os.ReadDir(filepath.Join(assets, "own", "rep", "webimg"))
	require.NoError(t, err)
	require.Len(t, entries, 1, "only the in-limit image is persisted")
	assert.Equal(t, ".png", filepath.Ext(entries[0].Name()))
	requestPathMu.Lock()
	_ = requestPath
	requestPathMu.Unlock()
}

func TestExtractWebPageTitle(t *testing.T) {
	tests := []struct {
		name       string
		html       string
		useContent bool
		want       string
	}{
		{
			name: "mdBook: ignore sidebar menu-title h1, pick article main h1",
			html: `<!DOCTYPE html>
<html>
<head><title>Using Linear Memory - Wasmtime</title></head>
<body>
  <nav class="sidebar" role="navigation">
    <h1 class="menu-title">Wasmtime</h1>
  </nav>
  <main>
    <div id="content" class="content">
      <h1 id="using-linear-memory">Using linear memory</h1>
      <p>Article body here...</p>
    </div>
  </main>
</body>
</html>`,
			useContent: true,
			want:       "Using linear memory",
		},
		{
			name: "Sphinx doc: sidebar logo h1 ignored, content section h1 picked",
			html: `<!DOCTYPE html>
<html>
<head><title>Kernel MM - The Linux Kernel</title></head>
<body>
  <aside class="sidebar">
    <div class="brand"><h1 class="logo">The Linux Kernel</h1></div>
  </aside>
  <div class="document">
    <div class="body" role="main">
      <h1>Memory Management Guide</h1>
      <p>Body...</p>
    </div>
  </div>
</body>
</html>`,
			useContent: true,
			want:       "Memory Management Guide",
		},
		{
			name: "No content h1: fallback to og:title with site suffix stripped",
			html: `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="Quickstart Guide - Wasmtime Documentation" />
</head>
<body>
  <nav><h1 class="sidebar-title">Wasmtime</h1></nav>
  <main><p>No h1 here</p></main>
</body>
</html>`,
			useContent: true,
			want:       "Quickstart Guide",
		},
		{
			name: "No content h1 or og:title: fallback to doc title with site suffix stripped",
			html: `<!DOCTYPE html>
<html>
<head>
  <title>Twelve-Factor App | The Twelve-Factor App</title>
</head>
<body>
  <header><h1>The Twelve-Factor App</h1></header>
  <main><p>No h1</p></main>
</body>
</html>`,
			useContent: true,
			want:       "Twelve-Factor App",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doc, err := html.Parse(strings.NewReader(tt.html))
			require.NoError(t, err)

			var contentNode *html.Node
			if tt.useContent {
				contentNode = findMainContentNode(doc)
			}
			got := ExtractWebPageTitle(doc, contentNode)
			assert.Equal(t, tt.want, got)
		})
	}
}
