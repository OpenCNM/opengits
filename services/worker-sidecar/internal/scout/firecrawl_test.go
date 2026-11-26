package scout

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFirecrawlScrapeUrl(t *testing.T) {
	tests := []struct {
		name        string
		handler     http.HandlerFunc
		targetURL   string
		wantErr     bool
		errContains string
		checkDoc    func(t *testing.T, doc *FirecrawlDoc)
	}{
		{
			name:      "successful scrape with data.markdown and metadata",
			targetURL: "https://example.com/docs/guide",
			handler: func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, "/v1/scrape", r.URL.Path)
				assert.Equal(t, http.MethodPost, r.Method)

				var body map[string]any
				err := json.NewDecoder(r.Body).Decode(&body)
				assert.NoError(t, err)
				assert.Equal(t, "https://example.com/docs/guide", body["url"])

				resp := map[string]any{
					"success": true,
					"data": map[string]any{
						"markdown": "# Guide Title\n\nThis is the content for testing.\n\n## Sub Section\nSome details here.",
						"metadata": map[string]any{
							"title":     "Custom Guide Title",
							"sourceURL": "https://example.com/docs/guide",
						},
					},
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(resp)
			},
			wantErr: false,
			checkDoc: func(t *testing.T, doc *FirecrawlDoc) {
				require.NotNil(t, doc)
				assert.Equal(t, "docs/guide.md", doc.Path)
				assert.Equal(t, "Custom Guide Title", doc.Title)
				assert.Contains(t, doc.Markdown, "# Guide Title")
				assert.NotEmpty(t, doc.ContentHash)
				assert.Equal(t, "firecrawl", doc.Metadata["engine"])
				require.Len(t, doc.Headings, 2)
				assert.Equal(t, "Guide Title", doc.Headings[0].Text)
				assert.Equal(t, 1, doc.Headings[0].Level)
				assert.Equal(t, "Sub Section", doc.Headings[1].Text)
				assert.Equal(t, 2, doc.Headings[1].Level)
			},
		},
		{
			name:      "successful scrape with root markdown and title fallback",
			targetURL: "https://example.com/api/reference",
			handler: func(w http.ResponseWriter, r *http.Request) {
				resp := map[string]any{
					"success":  true,
					"markdown": "Plain markdown content without title metadata.",
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(resp)
			},
			wantErr: false,
			checkDoc: func(t *testing.T, doc *FirecrawlDoc) {
				require.NotNil(t, doc)
				assert.Equal(t, "api/reference.md", doc.Path)
				assert.Equal(t, "api/reference", doc.Title)
			},
		},
		{
			name:      "scrape returns empty markdown",
			targetURL: "https://example.com/empty",
			handler: func(w http.ResponseWriter, r *http.Request) {
				resp := map[string]any{
					"success":  true,
					"markdown": "   ",
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(resp)
			},
			wantErr:     true,
			errContains: "empty markdown content",
		},
		{
			name:      "scrape returns HTTP 500 error",
			targetURL: "https://example.com/err",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"error":"internal firecrawl crash"}`))
			},
			wantErr:     true,
			errContains: "HTTP 500",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(tt.handler)
			defer server.Close()

			client := NewFirecrawlClient(server.URL, "test-api-key")
			doc, err := client.ScrapeUrl(context.Background(), tt.targetURL)
			if tt.wantErr {
				require.Error(t, err)
				if tt.errContains != "" {
					assert.Contains(t, err.Error(), tt.errContains)
				}
			} else {
				require.NoError(t, err)
				if tt.checkDoc != nil {
					tt.checkDoc(t, doc)
				}
			}
		})
	}
}

func TestFirecrawlCrawl(t *testing.T) {
	tests := []struct {
		name        string
		startStatus int
		startBody   any
		pollStatus  int
		pollBody    any
		limit       int
		wantErr     bool
		errContains string
		checkDocs   func(t *testing.T, docs []FirecrawlDoc)
	}{
		{
			name:        "crawl success with polling and filtering small pages",
			startStatus: http.StatusOK,
			startBody:   map[string]any{"id": "crawl-job-123"},
			pollStatus:  http.StatusOK,
			pollBody: map[string]any{
				"status":    "completed",
				"total":     2,
				"completed": 2,
				"data": []map[string]any{
					{
						"markdown": "# Page 1\nThis is valid content with more than 50 characters to pass the min length check.",
						"metadata": map[string]any{
							"title":     "Page 1 Title",
							"sourceURL": "https://example.com/docs/page-1",
						},
					},
					{
						"markdown": "Too short",
						"metadata": map[string]any{
							"title":     "Short Page",
							"sourceURL": "https://example.com/docs/short",
						},
					},
				},
			},
			limit:   10,
			wantErr: false,
			checkDocs: func(t *testing.T, docs []FirecrawlDoc) {
				require.Len(t, docs, 1, "short page must be filtered out")
				assert.Equal(t, "docs/page-1.md", docs[0].Path)
				assert.Equal(t, "Page 1 Title", docs[0].Title)
				assert.NotEmpty(t, docs[0].ContentHash)
			},
		},
		{
			name:        "crawl job failed status",
			startStatus: http.StatusOK,
			startBody:   map[string]any{"id": "crawl-job-fail"},
			pollStatus:  http.StatusOK,
			pollBody: map[string]any{
				"status": "failed",
				"error":  "site is unreachable or blocked",
			},
			limit:       5,
			wantErr:     true,
			errContains: "site is unreachable or blocked",
		},
		{
			name:        "crawl start returns error",
			startStatus: http.StatusBadRequest,
			startBody:   map[string]any{"error": "invalid URL"},
			limit:       5,
			wantErr:     true,
			errContains: "HTTP 400",
		},
		{
			name:        "crawl polling unauthorized returns error",
			startStatus: http.StatusOK,
			startBody:   map[string]any{"id": "crawl-job-auth-fail"},
			pollStatus:  http.StatusUnauthorized,
			pollBody:    map[string]any{"error": "invalid api key"},
			limit:       5,
			wantErr:     true,
			errContains: "HTTP 401",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var pollCount int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/v1/crawl" {
					w.WriteHeader(tt.startStatus)
					_ = json.NewEncoder(w).Encode(tt.startBody)
					return
				}
				if r.URL.Path == "/v1/crawl/crawl-job-123" || r.URL.Path == "/v1/crawl/crawl-job-fail" || r.URL.Path == "/v1/crawl/crawl-job-auth-fail" {
					atomic.AddInt32(&pollCount, 1)
					w.WriteHeader(tt.pollStatus)
					_ = json.NewEncoder(w).Encode(tt.pollBody)
					return
				}
				w.WriteHeader(http.StatusNotFound)
			}))
			defer server.Close()

			client := NewFirecrawlClient(server.URL, "test-key")
			client.pollInterval = 10 * time.Millisecond

			docs, err := client.Crawl(context.Background(), "https://example.com", tt.limit, nil)
			if tt.wantErr {
				require.Error(t, err)
				if tt.errContains != "" {
					assert.Contains(t, err.Error(), tt.errContains)
				}
			} else {
				require.NoError(t, err)
				if tt.checkDocs != nil {
					tt.checkDocs(t, docs)
				}
			}
		})
	}
}

func TestCanonicalDocPathFromUrl(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "https://example.com/docs/guide", want: "docs/guide.md"},
		{input: "https://example.com/docs/guide/", want: "docs/guide.md"},
		{input: "https://example.com/", want: "index.md"},
		{input: "https://example.com", want: "index.md"},
		{input: "https://example.com/api/v1/endpoints", want: "api/v1/endpoints.md"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := CanonicalDocPathFromUrl(tt.input)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestExtractHeadingsFromMarkdown(t *testing.T) {
	tests := []struct {
		name     string
		markdown string
		want     []FirecrawlHeading
	}{
		{
			name:     "headings outside code blocks",
			markdown: "# Title\n\nSome text\n\n## Subtitle\n\n```python\n# This is a comment inside code\ndef hello():\n    pass\n```\n\n### After Code\nMore text",
			want: []FirecrawlHeading{
				{Level: 1, Text: "Title", ID: "title"},
				{Level: 2, Text: "Subtitle", ID: "subtitle"},
				{Level: 3, Text: "After Code", ID: "after-code"},
			},
		},
		{
			name:     "tilde code fence protection",
			markdown: "~~~go\n// # Not a heading\n~~~\n## Real Heading",
			want: []FirecrawlHeading{
				{Level: 2, Text: "Real Heading", ID: "real-heading"},
			},
		},
		{
			name:     "cjk headings preserved without empty ids",
			markdown: "# 快速开始\n\n正文内容\n\n## 架构设计与实现\n\n### はじめに",
			want: []FirecrawlHeading{
				{Level: 1, Text: "快速开始", ID: "快速开始"},
				{Level: 2, Text: "架构设计与实现", ID: "架构设计与实现"},
				{Level: 3, Text: "はじめに", ID: "はじめに"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractHeadingsFromMarkdown(tt.markdown)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestFirecrawlHTMLIngestionPipeline(t *testing.T) {
	tests := []struct {
		name           string
		htmlPayload    string
		mdFallback     string
		wantFormats    []any
		mustContain    []string
		mustNotContain []string
	}{
		{
			name: "scrape_prefers_dom_lift_over_flattened_markdown_when_html_valid",
			htmlPayload: `<!DOCTYPE html><html><body><main>
				<h1><svg aria-hidden="true"><title>Sparkles</title><path d="M0 0"/></svg>Use Cases</h1>
				<p>Deploy production workflows with zero leaked SVG markup or broken multiline anchors across documentation cards.</p>
				<div class="grid grid-cols-2 gap-4">
					<a href="/docs/use-cases/triage"><div><h3>Triage Agent</h3><p>Classify issues and notify owners automatically.</p></div></a>
					<a href="/docs/use-cases/review"><div><h3>Review Agent</h3><p>Inspect pull requests and enforce architecture policies.</p></div></a>
				</div>
			</main></body></html>`,
			mdFallback:     "# Use Cases\n\n[Triage Agent\nClassify issues](/docs/use-cases/triage)",
			wantFormats:    []any{"markdown", "html"},
			mustContain:    []string{"<CardGroup", `<Card title="Triage Agent"`, `href="/docs/use-cases/triage"`},
			mustNotContain: []string{"<svg", "Sparkles", "[Triage Agent\nClassify issues]"},
		},
		{
			name:           "scrape_falls_back_to_firecrawl_markdown_when_html_absent",
			htmlPayload:    "",
			mdFallback:     "# Short Reference\n\nPlain Firecrawl markdown fallback stays intact when HTML is omitted.",
			wantFormats:    []any{"markdown", "html"},
			mustContain:    []string{"Plain Firecrawl markdown fallback stays intact"},
			mustNotContain: []string{"<CardGroup"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var reqBody map[string]any
				require.NoError(t, json.NewDecoder(r.Body).Decode(&reqBody))
				assert.Equal(t, tt.wantFormats, reqBody["formats"])

				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"success": true,
					"data": map[string]any{
						"markdown": tt.mdFallback,
						"html":     tt.htmlPayload,
						"metadata": map[string]any{"sourceURL": "https://example.com/docs/use-cases"},
					},
				})
			}))
			defer srv.Close()

			client := NewFirecrawlClient(srv.URL, "")
			doc, err := client.ScrapeUrl(context.Background(), "https://example.com/docs/use-cases")
			require.NoError(t, err)
			require.NotNil(t, doc)
			for _, want := range tt.mustContain {
				assert.Contains(t, doc.Markdown, want)
			}
			for _, forbid := range tt.mustNotContain {
				assert.NotContains(t, doc.Markdown, forbid)
			}
			if tt.htmlPayload != "" {
				assert.Equal(t, tt.htmlPayload, doc.Metadata["rawHtml"])
				require.NotNil(t, doc.Telemetry)
				assert.Equal(t, 1, doc.Telemetry.PagesScanned)
				assert.Equal(t, 2, doc.Telemetry.CardsLifted)
				assert.GreaterOrEqual(t, doc.Telemetry.SvgsStripped, 1)
			} else {
				assert.Nil(t, doc.Telemetry)
			}
		})
	}
}
