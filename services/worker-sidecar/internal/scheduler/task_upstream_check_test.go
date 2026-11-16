package scheduler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/webdoc"
)

// 🧪 [5.7.3.1] & [5.7.3.3] Table-Driven: Web 文档库原生 DetectWebDocDiff 周期探测与红点标记测试
func TestCheckUpstreamOnceWebDoc(t *testing.T) {
	webdoc.AllowTestLoopback = true
	defer func() { webdoc.AllowTestLoopback = false }()

	tests := []struct {
		name              string
		setupServer       func(t *testing.T, callCount *int32) *httptest.Server
		repos             func(serverURL string) []RepoRow
		wantWebChecked    []string // repoID:hasUpdate:etag
		expectedCallCount int32
		cancelCtx         bool
	}{
		{
			name: "Web 仓库检测到变动：标记 hasUpstreamUpdate = true 并刷新 etag",
			setupServer: func(_ *testing.T, count *int32) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					atomic.AddInt32(count, 1)
					w.Header().Set("Content-Type", "application/xml")
					w.Header().Set("ETag", `W/"new-web-etag"`)
					w.WriteHeader(http.StatusOK)
					docURL := fmt.Sprintf("http://%s/new-page", r.Host)
					xml := fmt.Sprintf(`<?xml version="1.0"?><urlset><url><loc>%s</loc><lastmod>2026-03-01</lastmod></url></urlset>`, docURL)
					_, _ = w.Write([]byte(xml))
				}))
			},
			repos: func(serverURL string) []RepoRow {
				return []RepoRow{
					{
						ID:     "repo-web-changed",
						Owner:  "opengits",
						Repo:   "docs",
						Branch: "main",
						Etag:   strp(`W/"old-web-etag"`),
						ProfileJSON: []byte(fmt.Sprintf(`{
							"sourceType": "web",
							"originalUrl": "%s",
							"sitemapLastModMap": {
								"http://example.com/old": "2026-01-01"
							}
						}`, serverURL)),
					},
				}
			},
			wantWebChecked:    []string{`repo-web-changed:hasUpdate=true:W/"new-web-etag"`},
			expectedCallCount: 1,
		},
		{
			name: "Web 仓库检测到无变动（304 命中）：标记 hasUpstreamUpdate = false 并刷新 checkedAt",
			setupServer: func(_ *testing.T, count *int32) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					atomic.AddInt32(count, 1)
					if r.Header.Get("If-None-Match") == `W/"current-etag"` {
						w.WriteHeader(http.StatusNotModified)
						return
					}
					w.Header().Set("Content-Type", "application/xml")
					w.Header().Set("ETag", `W/"current-etag"`)
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(`<?xml version="1.0"?><urlset></urlset>`))
				}))
			},
			repos: func(serverURL string) []RepoRow {
				return []RepoRow{
					{
						ID:     "repo-web-304",
						Owner:  "opengits",
						Repo:   "docs-unchanged",
						Branch: "main",
						Etag:   strp(`W/"current-etag"`),
						ProfileJSON: []byte(fmt.Sprintf(`{
							"sourceType": "web",
							"originalUrl": "%s"
						}`, serverURL)),
					},
				}
			},
			wantWebChecked:    []string{`repo-web-304:hasUpdate=false:W/"current-etag"`},
			expectedCallCount: 1,
		},
		{
			name: "同一 originalUrl 组共享单次探测并写回所有同源仓库（杜绝重复探测浪费上游配额）",
			setupServer: func(_ *testing.T, count *int32) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					atomic.AddInt32(count, 1)
					w.Header().Set("Content-Type", "application/xml")
					w.Header().Set("ETag", `W/"shared-etag"`)
					w.WriteHeader(http.StatusOK)
					docURL := fmt.Sprintf("http://%s/doc", r.Host)
					xml := fmt.Sprintf(`<?xml version="1.0"?><urlset><url><loc>%s</loc><lastmod>2026-01-01</lastmod></url></urlset>`, docURL)
					_, _ = w.Write([]byte(xml))
				}))
			},
			repos: func(serverURL string) []RepoRow {
				profile := []byte(fmt.Sprintf(`{
					"sourceType": "web",
					"originalUrl": "%s",
					"sitemapLastModMap": {
						"%s/doc": "2026-01-01"
					}
				}`, serverURL, serverURL))
				return []RepoRow{
					{ID: "repo-web-fork-1", Owner: "user1", Repo: "docs", Branch: "main", ProfileJSON: profile},
					{ID: "repo-web-fork-2", Owner: "user2", Repo: "docs", Branch: "main", ProfileJSON: profile},
				}
			},
			wantWebChecked: []string{
				`repo-web-fork-1:hasUpdate=false:W/"shared-etag"`,
				`repo-web-fork-2:hasUpdate=false:W/"shared-etag"`,
			},
			expectedCallCount: 1,
		},
		{
			name: "探测因上下文取消失败时优雅跳过，不写入误判红点",
			setupServer: func(_ *testing.T, count *int32) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					atomic.AddInt32(count, 1)
					w.WriteHeader(http.StatusOK)
				}))
			},
			repos: func(serverURL string) []RepoRow {
				return []RepoRow{
					{
						ID:     "repo-web-cancelled",
						Owner:  "opengits",
						Repo:   "docs",
						Branch: "main",
						ProfileJSON: []byte(fmt.Sprintf(`{
							"sourceType": "web",
							"originalUrl": "%s"
						}`, serverURL)),
					},
				}
			},
			wantWebChecked:    nil,
			expectedCallCount: 0,
			cancelCtx:         true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ResetGatewayPolicyForTest()
			var callCount int32
			server := tt.setupServer(t, &callCount)
			defer server.Close()

			f := newFakeStore()
			f.leaseRows = 1
			f.upstreamRepos = tt.repos(server.URL)

			cfg := Config{
				GitHubAPIBase: server.URL,
			}

			ctx := context.Background()
			if tt.cancelCtx {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}

			CheckUpstreamOnce(ctx, cfg, f)

			assert.Equal(t, tt.expectedCallCount, atomic.LoadInt32(&callCount), "HTTP probe calls count should match")
			require.Len(t, f.written, len(tt.wantWebChecked))
			for i, want := range tt.wantWebChecked {
				assert.Equal(t, want, f.written[i])
			}
		})
	}
}
