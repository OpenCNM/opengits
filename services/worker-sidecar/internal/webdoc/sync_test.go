package webdoc

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type syncMockFirecrawl struct {
	docs map[string]*FirecrawlDoc
	err  error
}

func (m *syncMockFirecrawl) ScrapeUrl(_ context.Context, u string) (*FirecrawlDoc, error) {
	if m.err != nil {
		return nil, m.err
	}
	if d, ok := m.docs[u]; ok {
		return d, nil
	}
	return nil, fmt.Errorf("url not found: %s", u)
}

func (m *syncMockFirecrawl) Crawl(_ context.Context, _ string, _ int, _ *CrawlFilters) ([]FirecrawlDoc, error) {
	return nil, nil
}

type fakeSyncStore struct {
	webRepo              *WebSyncRepoInfo
	touchCalled          bool
	lastTouchRepoID      string
	lastTouchEtag        string
	lastTouchModMap      map[string]string
	lastWebSyncTxParams  *WebSyncTxParams
	failAt               string
	replacedChunksCount  int
}

func (f *fakeSyncStore) GetRepositoryForWebSync(_ context.Context, _, _ string) (*WebSyncRepoInfo, error) {
	if f.failAt == "get_repo" {
		return nil, fmt.Errorf("boom")
	}
	return f.webRepo, nil
}

func (f *fakeSyncStore) TouchWebSyncNoChanges(_ context.Context, repoID, etag string, lastModMap map[string]string) error {
	f.touchCalled = true
	f.lastTouchRepoID = repoID
	f.lastTouchEtag = etag
	f.lastTouchModMap = lastModMap
	if f.failAt == "touch" {
		return fmt.Errorf("boom")
	}
	return nil
}

func (f *fakeSyncStore) ExecuteWebSyncTx(_ context.Context, p WebSyncTxParams) ([]WebSyncSavedDoc, error) {
	f.lastWebSyncTxParams = &p
	if f.failAt == "exec_web_sync" {
		return nil, fmt.Errorf("boom")
	}
	var saved []WebSyncSavedDoc
	for _, doc := range p.UpdatedDocs {
		saved = append(saved, WebSyncSavedDoc{
			ID:      "doc-" + doc.Path,
			Path:    doc.Path,
			Content: doc.Markdown,
		})
	}
	return saved, nil
}

func (f *fakeSyncStore) ReplaceDocumentChunks(_ context.Context, _ string, chunks []chunker.MarkdownChunk, _ ReplaceChunksOpts) (int, error) {
	f.replacedChunksCount += len(chunks)
	return len(chunks), nil
}

func strp(s string) *string {
	return &s
}

func intPtr(i int) *int {
	return &i
}

// 🧪 [1.5.1.2] & [1.5.3.1] Table-Driven 增量同步全分支回归测试
func TestWebDocSync(t *testing.T) {
	AllowTestLoopback = true
	defer func() { AllowTestLoopback = false }()

	tests := []struct {
		name                 string
		setupServer          func(t *testing.T) *httptest.Server
		repoInfo             *WebSyncRepoInfo
		failAt               string
		failSettle           bool
		wantOutcome          SyncOutcome
		assertStore          func(t *testing.T, store *fakeSyncStore, serverURL string)
		assertSettleDocs     *int
		assertSettleShaEmpty bool
	}{
		{
			name: "0 变更短路分支（Sitemap 304）：直刷基线、0 积分结算、返回 SyncDone",
			setupServer: func(t *testing.T) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("If-None-Match") == `W/"cached-etag"` {
						w.WriteHeader(http.StatusNotModified)
						return
					}
					w.Header().Set("Content-Type", "application/xml")
					w.Header().Set("ETag", `W/"new-etag"`)
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(`<?xml version="1.0"?><urlset></urlset>`))
				}))
			},
			repoInfo: &WebSyncRepoInfo{
				ID:           "repo-web-1",
				IsPublic:     true,
				Branch:       "main",
				UpstreamEtag: strp(`W/"cached-etag"`),
				SourceType:   "web",
				SitemapLastModMap: map[string]string{
					"http://example.com/doc1": "2026-01-01",
				},
			},
			wantOutcome: SyncDone,
			assertStore: func(t *testing.T, store *fakeSyncStore, _ string) {
				assert.True(t, store.touchCalled, "touchWebSyncNoChanges must be called on 304")
				assert.Equal(t, `W/"cached-etag"`, store.lastTouchEtag)
			},
			assertSettleDocs: intPtr(0),
		},
		{
			name: "0 变更短路分支（Sitemap 200 且 lastmod 无变动）：直刷基线、0 积分结算、返回 SyncDone",
			setupServer: func(t *testing.T) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/xml")
					w.Header().Set("ETag", `W/"etag-200"`)
					w.WriteHeader(http.StatusOK)
					docURL := fmt.Sprintf("http://%s/intro", r.Host)
					xml := fmt.Sprintf(`<?xml version="1.0"?><urlset><url><loc>%s</loc><lastmod>2026-01-01</lastmod></url></urlset>`, docURL)
					_, _ = w.Write([]byte(xml))
				}))
			},
			repoInfo: &WebSyncRepoInfo{
				ID:         "repo-web-2",
				IsPublic:   true,
				Branch:     "main",
				SourceType: "web",
				SitemapLastModMap: map[string]string{
					"PLACEHOLDER/intro": "2026-01-01",
				},
			},
			wantOutcome: SyncDone,
			assertStore: func(t *testing.T, store *fakeSyncStore, serverURL string) {
				assert.True(t, store.touchCalled)
				assert.Equal(t, `W/"etag-200"`, store.lastTouchEtag)
				introURL := fmt.Sprintf("%s/intro", serverURL)
				assert.Equal(t, "2026-01-01", store.lastTouchModMap[introURL])
			},
			assertSettleDocs: intPtr(0),
		},
		{
			name: "增量抓取与更新分支（新增 + 更新）：并发抓取、内容清洗、事务写入、切片刷新",
			setupServer: func(t *testing.T) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/sitemap.xml" || r.URL.Path == "/" {
						w.Header().Set("Content-Type", "application/xml")
						w.Header().Set("ETag", `W/"etag-v2"`)
						w.WriteHeader(http.StatusOK)
						addURL := fmt.Sprintf("http://%s/new-guide", r.Host)
						updURL := fmt.Sprintf("http://%s/updated-api", r.Host)
						xml := fmt.Sprintf(`<?xml version="1.0"?>
							<urlset>
								<url><loc>%s</loc><lastmod>2026-02-01</lastmod></url>
								<url><loc>%s</loc><lastmod>2026-02-02</lastmod></url>
							</urlset>`, addURL, updURL)
						_, _ = w.Write([]byte(xml))
						return
					}
					// 静态网页快道响应（包含 MDX 花括号需自愈的内容）
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(`<!DOCTYPE html>
						<html>
						<head><title>Page Title | Site</title></head>
						<body>
							<main>
								<h1>Guide Heading</h1>
								<p>Valid content with {variable} mdx braces that need healing.</p>
								<p>More detailed documentation content over 200 characters to qualify as valid static content in fast path scanner.</p>
							</main>
						</body>
						</html>`))
				}))
			},
			repoInfo: &WebSyncRepoInfo{
				ID:           "repo-web-3",
				IsPublic:     true,
				Branch:       "main",
				UpstreamEtag: strp(`W/"etag-v1"`),
				SourceType:   "web",
				SitemapLastModMap: map[string]string{
					"PLACEHOLDER/updated-api": "2026-01-01", // 比 sitemap 的 2026-02-02 旧，触发 update
				},
			},
			wantOutcome: SyncDone,
			assertStore: func(t *testing.T, store *fakeSyncStore, _ string) {
				require.NotNil(t, store.lastWebSyncTxParams, "ExecuteWebSyncTx must be executed")
				assert.Equal(t, `W/"etag-v2"`, store.lastWebSyncTxParams.ETag)
				assert.Len(t, store.lastWebSyncTxParams.UpdatedDocs, 2, "2 pages scraped and updated")
				assert.NotEmpty(t, store.lastWebSyncTxParams.AggregateSha)
				assert.Greater(t, store.replacedChunksCount, 0, "ReplaceDocumentChunks should be called for docs")
			},
			assertSettleDocs: intPtr(2),
		},
		{
			name: "页面移除分支：CanonicalDocPathFromUrl 转换与物理删除",
			setupServer: func(t *testing.T) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/xml")
					w.Header().Set("ETag", `W/"etag-v3"`)
					w.WriteHeader(http.StatusOK)
					keptURL := fmt.Sprintf("http://%s/kept", r.Host)
					xml := fmt.Sprintf(`<?xml version="1.0"?><urlset><url><loc>%s</loc><lastmod>2026-01-01</lastmod></url></urlset>`, keptURL)
					_, _ = w.Write([]byte(xml))
				}))
			},
			repoInfo: &WebSyncRepoInfo{
				ID:           "repo-web-4",
				IsPublic:     true,
				Branch:       "main",
				UpstreamEtag: strp(`W/"etag-v2"`),
				SourceType:   "web",
				SitemapLastModMap: map[string]string{
					"PLACEHOLDER/kept":                 "2026-01-01",
					"http://example.com/docs/obsolete": "2026-01-01",
				},
			},
			wantOutcome: SyncDone,
			assertStore: func(t *testing.T, store *fakeSyncStore, _ string) {
				require.NotNil(t, store.lastWebSyncTxParams)
				assert.Contains(t, store.lastWebSyncTxParams.RemovedPaths, "docs/obsolete.md")
				assert.Empty(t, store.lastWebSyncTxParams.UpdatedDocs)
			},
			assertSettleDocs: intPtr(0),
		},
		{
			name: "非 web 仓库降级回落：返回 SyncFallback",
			setupServer: func(t *testing.T) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusOK)
				}))
			},
			repoInfo: &WebSyncRepoInfo{
				ID:         "repo-git-1",
				IsPublic:   true,
				Branch:     "main",
				SourceType: "git", // 非 web
			},
			wantOutcome: SyncFallback,
		},
		{
			name: "Sitemap 探测失败（500 错误）：返回 SyncFallback",
			setupServer: func(t *testing.T) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusInternalServerError)
				}))
			},
			repoInfo: &WebSyncRepoInfo{
				ID:         "repo-web-err",
				IsPublic:   true,
				Branch:     "main",
				SourceType: "web",
			},
			wantOutcome: SyncFallback,
		},
		{
			name: "ExecuteWebSyncTx 事务执行失败：返回 SyncFallback",
			setupServer: func(t *testing.T) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/" || r.URL.Path == "/sitemap.xml" {
						w.Header().Set("Content-Type", "application/xml")
						w.WriteHeader(http.StatusOK)
						newURL := fmt.Sprintf("http://%s/new-page", r.Host)
						xml := fmt.Sprintf(`<?xml version="1.0"?><urlset><url><loc>%s</loc></url></urlset>`, newURL)
						_, _ = w.Write([]byte(xml))
						return
					}
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(`<html><head><title>Documentation Guide</title></head><body><main><h1>Full Guide Heading</h1><p>Valid documentation content with enough characters to pass fast path scanner thresholds cleanly without any false negative fallback.</p><p>Second paragraph providing extensive detailed text to make sure the extracted markdown easily exceeds the minimum required threshold of one hundred and fifty characters.</p></main></body></html>`))
				}))
			},
			repoInfo: &WebSyncRepoInfo{
				ID:         "repo-web-fail",
				IsPublic:   true,
				Branch:     "main",
				SourceType: "web",
			},
			failAt:      "exec_web_sync",
			wantOutcome: SyncFallback,
			assertStore: func(t *testing.T, store *fakeSyncStore, _ string) {
				assert.NotNil(t, store.lastWebSyncTxParams, "ExecuteWebSyncTx must have been invoked and failed")
			},
		},
		{
			name: "0 变更时 settle 结算失败：返回 SyncFallback",
			setupServer: func(t *testing.T) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("If-None-Match") == `W/"cached-etag"` {
						w.WriteHeader(http.StatusNotModified)
						return
					}
					w.WriteHeader(http.StatusOK)
				}))
			},
			repoInfo: &WebSyncRepoInfo{
				ID:           "repo-web-settle-fail",
				IsPublic:     true,
				Branch:       "main",
				UpstreamEtag: strp(`W/"cached-etag"`),
				SourceType:   "web",
			},
			failSettle:  true,
			wantOutcome: SyncFallback,
		},
		{
			name: "有变更落库后 settle 结算失败：返回 SyncFallback",
			setupServer: func(t *testing.T) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/" || r.URL.Path == "/sitemap.xml" {
						w.Header().Set("Content-Type", "application/xml")
						w.WriteHeader(http.StatusOK)
						newURL := fmt.Sprintf("http://%s/new-page", r.Host)
						xml := fmt.Sprintf(`<?xml version="1.0"?><urlset><url><loc>%s</loc></url></urlset>`, newURL)
						_, _ = w.Write([]byte(xml))
						return
					}
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(`<html><head><title>Documentation Guide</title></head><body><main><h1>Full Guide Heading</h1><p>Valid documentation content with enough characters to pass fast path scanner thresholds cleanly without any false negative fallback.</p><p>Second paragraph providing extensive detailed text to make sure the extracted markdown easily exceeds the minimum required threshold of one hundred and fifty characters.</p></main></body></html>`))
				}))
			},
			repoInfo: &WebSyncRepoInfo{
				ID:         "repo-web-settle-fail-2",
				IsPublic:   true,
				Branch:     "main",
				SourceType: "web",
			},
			failSettle:  true,
			wantOutcome: SyncFallback,
			assertStore: func(t *testing.T, store *fakeSyncStore, _ string) {
				assert.NotNil(t, store.lastWebSyncTxParams, "Transaction succeeded before settle failed")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := tt.setupServer(t)
			defer server.Close()

			store := &fakeSyncStore{failAt: tt.failAt}
			if tt.repoInfo != nil {
				repo := *tt.repoInfo
				repo.OriginalURL = server.URL
				if repo.SitemapLastModMap != nil {
					newMap := make(map[string]string)
					for k, v := range repo.SitemapLastModMap {
						newMap[strings.ReplaceAll(k, "PLACEHOLDER", server.URL)] = v
					}
					repo.SitemapLastModMap = newMap
				}
				store.webRepo = &repo
			}

			settled := false
			settleDocsCount := 0
			var emittedEvents []struct {
				ev      string
				payload map[string]any
			}
			deps := SyncDeps{
				Store: store,
				Emit: func(ev string, p map[string]any) {
					emittedEvents = append(emittedEvents, struct {
						ev      string
						payload map[string]any
					}{ev: ev, payload: p})
				},
				Settle: func(_ context.Context, _ string, res SettleResult) error {
					if tt.failSettle {
						return fmt.Errorf("boom")
					}
					settled = true
					settleDocsCount = res.QueuedDocumentsCount
					return nil
				},
			}

			outcome := RunSync(context.Background(), deps, SyncJob{
				ID:     "job-sync-100",
				Owner:  "test-owner",
				Repo:   "test-repo",
				Branch: "main",
				UserID: "user-sync-1",
			})

			assert.Equal(t, tt.wantOutcome, outcome)

			if tt.wantOutcome == SyncFailed {
				hasErrorEvent := false
				for _, ev := range emittedEvents {
					if ev.ev == "error" {
						hasErrorEvent = true
						assert.NotEmpty(t, ev.payload["message"])
						break
					}
				}
				assert.True(t, hasErrorEvent, "when sync fails, an in-band 'error' event must be emitted")
			}

			if tt.assertStore != nil {
				tt.assertStore(t, store, server.URL)
			}
			if tt.assertSettleDocs != nil {
				assert.True(t, settled, "settle must be called")
				assert.Equal(t, *tt.assertSettleDocs, settleDocsCount)
			}
		})
	}
}

// 🧪 [1.5.1.2] 断言并发抓取目标页面顺序严格与输入一致
func TestCrawlTargetUrlsDeterministicOrder(t *testing.T) {
	AllowTestLoopback = true
	defer func() { AllowTestLoopback = false }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(fmt.Sprintf(`<!DOCTYPE html>
			<html><head><title>Page %s</title></head>
			<body><main>
				<h1>Heading %s</h1>
				<p>Long documentation content paragraph to satisfy static HTML threshold constraints and character length rules cleanly.</p>
				<p>Another paragraph to ensure the content exceeds the 150 characters markdown length rule without any issues whatsoever.</p>
			</main></body></html>`, r.URL.Path, r.URL.Path)))
	}))
	defer server.Close()

	urls := []string{
		server.URL + "/page-alpha",
		server.URL + "/page-beta",
		server.URL + "/page-gamma",
		server.URL + "/page-delta",
		server.URL + "/page-epsilon",
	}

	docs1 := CrawlTargetUrlsWithProgress(context.Background(), urls, nil, nil)
	docs2 := CrawlTargetUrlsWithProgress(context.Background(), urls, nil, nil)

	require.Len(t, docs1, len(urls))
	require.Len(t, docs2, len(urls))

	for i, u := range urls {
		assert.Equal(t, u, docs1[i].URL)
		assert.Equal(t, u, docs2[i].URL)
	}

	sha1 := ComputeWebDocAggregateSha(docs1)
	sha2 := ComputeWebDocAggregateSha(docs2)
	assert.Equal(t, sha1, sha2, "Aggregate SHA must be completely deterministic across executions")
}

// 🧪 [1.5.1.2] Context 取消时，RunSync 应安全优雅降级并返回 SyncFallback
func TestWebDocSyncContextCancelled(t *testing.T) {
	AllowTestLoopback = true
	defer func() { AllowTestLoopback = false }()

	store := &fakeSyncStore{
		webRepo: &WebSyncRepoInfo{
			ID:          "repo-cancelled",
			IsPublic:    true,
			Branch:      "main",
			SourceType:  "web",
			OriginalURL: "http://127.0.0.1:54321",
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // 立即取消

	settled := false
	deps := SyncDeps{
		Store: store,
		Emit:  func(_ string, _ map[string]any) {},
		Settle: func(_ context.Context, _ string, _ SettleResult) error {
			settled = true
			return nil
		},
	}

	outcome := RunSync(ctx, deps, SyncJob{
		ID:     "job-cancelled",
		Owner:  "test-owner",
		Repo:   "test-repo",
		Branch: "main",
	})
	assert.Equal(t, SyncFallback, outcome)
	assert.False(t, settled, "Settlement must not occur on cancelled context")
}

// 🧪 [1.5.1.3] 抓取页面超过 5 页时，应周期性分批广播抓取进度
func TestCrawlTargetUrlsWithProgressReporting(t *testing.T) {
	AllowTestLoopback = true
	defer func() { AllowTestLoopback = false }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(fmt.Sprintf(`<!DOCTYPE html>
			<html><head><title>Page %s</title></head>
			<body><main>
				<h1>Heading %s</h1>
				<p>Long documentation content paragraph to satisfy static HTML threshold constraints and character length rules cleanly.</p>
				<p>Another paragraph to ensure the content exceeds the 150 characters markdown length rule without any issues whatsoever.</p>
			</main></body></html>`, r.URL.Path, r.URL.Path)))
	}))
	defer server.Close()

	urls := []string{
		server.URL + "/p1",
		server.URL + "/p2",
		server.URL + "/p3",
		server.URL + "/p4",
		server.URL + "/p5",
		server.URL + "/p6",
	}

	var progressEvents []string
	emit := func(ev string, p map[string]any) {
		if ev == "log" {
			if msg, ok := p["message"].(string); ok && strings.Contains(msg, "页面抓取进度:") {
				progressEvents = append(progressEvents, msg)
			}
		}
	}

	docs := CrawlTargetUrlsWithProgress(context.Background(), urls, nil, emit)
	assert.Len(t, docs, 6)
	assert.NotEmpty(t, progressEvents, "progress events must be emitted when urls count >= 5")
	assert.Contains(t, progressEvents[len(progressEvents)-1], "6/6 (100%)")
}


// 🧪 作用域继承防漂移：导入期收敛落盘的生效作用域必须在增量同步处被强制执行，
// 阻断源站后续新增的越界页面（如新发 changelog）逆向渗透进已策展的库。
// 四类向量：显式 custom / auto excludes / auto primary-only（并集落盘）/ 全越界 0 变更短路。
func TestWebDocSyncScopeGuard(t *testing.T) {
	AllowTestLoopback = true
	defer func() { AllowTestLoopback = false }()

	newSyncSitemapServer := func(paths []string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/sitemap.xml" || r.URL.Path == "/" {
				w.Header().Set("Content-Type", "application/xml")
				w.Header().Set("ETag", `W/"etag-scope-v2"`)
				w.WriteHeader(http.StatusOK)
				locs := ""
				for _, p := range paths {
					locs += fmt.Sprintf("<url><loc>http://%s%s</loc><lastmod>2026-03-01</lastmod></url>", r.Host, p)
				}
				_, _ = w.Write([]byte(fmt.Sprintf(`<?xml version="1.0"?><urlset>%s</urlset>`, locs)))
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(fmt.Sprintf(`<html><head><title>Doc %s</title></head><body><main><h1>Heading %s</h1><p>Valid documentation content with enough characters to pass fast path scanner thresholds cleanly without any false negative fallback happening here.</p><p>Second paragraph providing extensive detailed text to make sure the extracted markdown easily exceeds the minimum required threshold of one hundred and fifty characters.</p></main></body></html>`, r.URL.Path, r.URL.Path)))
		}))
	}

	tests := []struct {
		name            string
		sitemapPaths    []string
		allowedPrefixes []string
		excludePrefixes []string
		wantDocs        int
		wantTouchOnly   bool
	}{
		{
			name:            "explicit custom scope blocks unselected module pages",
			sitemapPaths:    []string{"/docs/new-guide", "/integrations/connector", "/changelog/new-entry"},
			allowedPrefixes: []string{"/docs", "/integrations"},
			wantDocs:        2,
		},
		{
			name:            "auto decision excludes block newly published changelog",
			sitemapPaths:    []string{"/new-page", "/changelog/new-entry"},
			allowedPrefixes: nil,
			excludePrefixes: []string{"/changelog"},
			wantDocs:        1,
		},
		{
			name:            "auto primary-only scope (effective union persisted) blocks changelog",
			sitemapPaths:    []string{"/docs/new-guide", "/changelog/new-entry"},
			allowedPrefixes: []string{"/docs"},
			wantDocs:        1,
		},
		{
			name:            "all changes out of scope short-circuits as zero-change",
			sitemapPaths:    []string{"/changelog/new-entry", "/blog/post"},
			allowedPrefixes: []string{"/docs"},
			wantDocs:        0,
			wantTouchOnly:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := newSyncSitemapServer(tt.sitemapPaths)
			defer server.Close()

			store := &fakeSyncStore{webRepo: &WebSyncRepoInfo{
				ID:               "repo-scope-" + tt.name,
				IsPublic:         true,
				Branch:           "main",
				SourceType:       "web",
				AllowedPrefixes:  tt.allowedPrefixes,
				ExcludePrefixes:  tt.excludePrefixes,
			}}
			store.webRepo.OriginalURL = server.URL

			settledDocs := -1
			deps := SyncDeps{
				Store: store,
				Emit:  func(_ string, _ map[string]any) {},
				Settle: func(_ context.Context, _ string, res SettleResult) error {
					settledDocs = res.QueuedDocumentsCount
					return nil
				},
			}

			outcome := RunSync(context.Background(), deps, SyncJob{
				ID: "job-scope-1", Owner: "test-owner", Repo: "test-repo", Branch: "main", UserID: "u1",
			})

			assert.Equal(t, SyncDone, outcome)
			if tt.wantTouchOnly {
				assert.True(t, store.touchCalled, "fully out-of-scope diff must short-circuit via TouchWebSyncNoChanges")
				assert.Nil(t, store.lastWebSyncTxParams, "no sync transaction must run for out-of-scope diff")
				assert.Equal(t, 0, settledDocs)
				return
			}
			require.NotNil(t, store.lastWebSyncTxParams)
			require.Len(t, store.lastWebSyncTxParams.UpdatedDocs, tt.wantDocs)
			for _, d := range store.lastWebSyncTxParams.UpdatedDocs {
				assert.NotContains(t, d.Path, "changelog", "out-of-scope changelog pages must never be ingested by sync")
				assert.NotContains(t, d.Path, "blog")
			}
			assert.Equal(t, tt.wantDocs, settledDocs)
		})
	}
}

// 🧪 增量同步同步持久化同源图片与 DOM 升维产出的内联 SVG 图表资产（对齐 RunIngest）
func TestWebDocSyncAssetAndSVGPersistence(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)

	// 1x1 valid PNG payload
	pngBytes := []byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
		0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
		0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
		0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
		0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
		0x42, 0x60, 0x82,
	}

	tests := []struct {
		name        string
		owner       string
		repo        string
		pageHTML    string
		wantPngCnt  int
		wantSvgCnt  int
		mustContain []string
		mustNot     []string
	}{
		{
			name:  "same_origin_png_and_inline_figure_svg_persisted_during_sync",
			owner: "Test-Owner",
			repo:  "Test-Repo",
			pageHTML: `<!DOCTYPE html><html><head><title>Sync Architecture</title></head><body><main>
				<h1>Sync Architecture</h1>
				<p>` + strings.Repeat("Incremental web sync verifies same-origin image download and inline SVG diagram assetization cleanly. ", 3) + `</p>
				<img src="/images/flow.png" alt="Flow PNG" />
				<figure>
					<svg width="640" height="240" viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg">
						<title>Sync Topology</title>
						<script>evil()</script>
						<rect x="0" y="0" width="640" height="240" fill="#eee"/>
						<path d="M10 10 L600 200" stroke="#333"/>
					</svg>
					<figcaption>Architecture Flow</figcaption>
				</figure>
				<img src="https://cdn.example.invalid/external.png" alt="External CDN" />
			</main></body></html>`,
			wantPngCnt: 1,
			wantSvgCnt: 1,
			mustContain: []string{
				"/api/assets/test-owner/test-repo/webimg/",
				"https://cdn.example.invalid/external.png",
			},
			mustNot: []string{
				"/images/flow.png",
				"data:image/svg+xml;base64,",
				"<svg",
			},
		},
		{
			name:  "only_inline_svg_persisted_when_only_external_http_img_present",
			owner: "acme",
			repo:  "docs",
			pageHTML: `<!DOCTYPE html><html><head><title>SVG Only Sync</title></head><body><main>
				<h1>SVG Only Sync</h1>
				<p>` + strings.Repeat("Cross-origin HTTP images stay untouched while lifted inline diagram SVGs persist to local webimg storage. ", 3) + `</p>
				<figure>
					<svg width="480" height="200" viewBox="0 0 480 200" xmlns="http://www.w3.org/2000/svg">
						<rect x="10" y="10" width="200" height="80"/>
						<circle cx="300" cy="100" r="40"/>
					</svg>
				</figure>
				<img src="https://cdn.example.invalid/hero.png" alt="Hero Banner" />
			</main></body></html>`,
			wantPngCnt: 0,
			wantSvgCnt: 1,
			mustContain: []string{
				"/api/assets/acme/docs/webimg/",
				"https://cdn.example.invalid/hero.png",
			},
			mustNot: []string{
				"data:image/svg+xml;base64,",
				"<svg",
			},
		},
		{
			name:  "alt_matching_url_rewrites_only_target_not_alt",
			owner: "acme",
			repo:  "docs",
			pageHTML: `<!DOCTYPE html><html><head><title>Alt Parity</title></head><body><main>
				<h1>Alt Parity</h1>
				<p>` + strings.Repeat("When image alt text mirrors the source URL path, only the markdown destination parenthesis should be rewritten. ", 3) + `</p>
				<img src="/images/flow.png" alt="/images/flow.png" />
			</main></body></html>`,
			wantPngCnt: 1,
			wantSvgCnt: 0,
			mustContain: []string{
				"![/images/flow.png](/api/assets/acme/docs/webimg/",
			},
			mustNot: []string{
				"](/images/flow.png)",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tmpRoot := t.TempDir()
			t.Setenv("ASSETS_ROOT", tmpRoot)

			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/sitemap.xml", "/":
					w.Header().Set("Content-Type", "application/xml")
					w.Header().Set("ETag", `W/"etag-assets-v2"`)
					w.WriteHeader(http.StatusOK)
					pageURL := fmt.Sprintf("http://%s/docs/architecture", r.Host)
					_, _ = w.Write([]byte(fmt.Sprintf(`<?xml version="1.0"?><urlset><url><loc>%s</loc><lastmod>2026-04-01</lastmod></url></urlset>`, pageURL)))
				case "/images/flow.png":
					w.Header().Set("Content-Type", "image/png")
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write(pngBytes)
				case "/docs/architecture":
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(tt.pageHTML))
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()

			store := &fakeSyncStore{
				webRepo: &WebSyncRepoInfo{
					ID:          "repo-assets-" + tt.name,
					IsPublic:    true,
					Branch:      "main",
					OriginalURL: srv.URL,
					SourceType:  "web",
				},
			}

			var settledRes SettleResult
			deps := SyncDeps{
				Store: store,
				Emit:  func(_ string, _ map[string]any) {},
				Settle: func(_ context.Context, _ string, res SettleResult) error {
					settledRes = res
					return nil
				},
			}

			outcome := RunSync(context.Background(), deps, SyncJob{
				ID:     "job-sync-assets",
				Owner:  tt.owner,
				Repo:   tt.repo,
				Branch: "main",
				UserID: "user-sync-assets",
			})

			assert.Equal(t, SyncDone, outcome)
			require.NotNil(t, store.lastWebSyncTxParams)
			require.Len(t, store.lastWebSyncTxParams.UpdatedDocs, 1)

			syncedDoc := store.lastWebSyncTxParams.UpdatedDocs[0]
			for _, want := range tt.mustContain {
				assert.Contains(t, syncedDoc.Markdown, want)
			}
			for _, forbid := range tt.mustNot {
				assert.NotContains(t, syncedDoc.Markdown, forbid)
			}
			// AggregateSha must reflect the rewritten markdown hash
			assert.Equal(t, hashContent(syncedDoc.Markdown), syncedDoc.ContentHash)
			assert.Equal(t, ComputeWebDocAggregateSha(store.lastWebSyncTxParams.UpdatedDocs), store.lastWebSyncTxParams.AggregateSha)
			assert.Equal(t, store.lastWebSyncTxParams.AggregateSha, settledRes.GitSha)
			assert.Equal(t, 1, settledRes.QueuedDocumentsCount)

			lowerOwner := strings.ToLower(tt.owner)
			lowerRepo := strings.ToLower(tt.repo)
			pngFiles, err := filepath.Glob(filepath.Join(tmpRoot, lowerOwner, lowerRepo, "webimg", "*.png"))
			require.NoError(t, err)
			assert.Len(t, pngFiles, tt.wantPngCnt)

			svgFiles, err := filepath.Glob(filepath.Join(tmpRoot, lowerOwner, lowerRepo, "webimg", "*.svg"))
			require.NoError(t, err)
			require.Len(t, svgFiles, tt.wantSvgCnt)
			for _, sf := range svgFiles {
				rawSVG, readErr := os.ReadFile(sf)
				require.NoError(t, readErr)
				assert.NotContains(t, string(rawSVG), "<script")
				assert.NotContains(t, string(rawSVG), "<title")
			}
		})
	}
}
