package doc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockLlmsTxtStore struct {
	repoInfo *LlmsTxtRepoInfo
	docs     []LlmsTxtDoc
	err      error
}

func (m *mockLlmsTxtStore) GetLlmsTxtData(_ context.Context, _ string, _ *string) (*LlmsTxtRepoInfo, []LlmsTxtDoc, error) {
	if m.err != nil {
		return nil, nil, m.err
	}
	return m.repoInfo, m.docs, nil
}

func intPtr(i int) *int {
	return &i
}

func TestLlmsTxtHandler(t *testing.T) {
	const validToken = "test-secret-token"

	cat := "Web Framework"
	semVer := "v2.0.0"
	sampleNavTree := `[
		{"title": "Getting Started", "path": "docs/intro.md"},
		{"title": "Advanced Topics", "path": "docs/advanced.md", "children": [
			{"title": "API Reference", "path": "docs/api.md"},
			{"title": "Migration Guide", "path": "docs/migration.md"}
		]}
	]`

	defaultRepoInfo := &LlmsTxtRepoInfo{
		Owner:       "test-owner",
		Repo:        "test-repo",
		Branch:      "main",
		Category:    &cat,
		SemVerLabel: &semVer,
		NavTree:     []byte(sampleNavTree),
	}

	defaultDocs := []LlmsTxtDoc{
		{
			ID:      "doc-1",
			Title:   strPtr("Getting Started"),
			Path:    "docs/intro.md",
			Summary: strPtr("Introduction to the framework."),
			Content: "# Getting Started\nWelcome to the framework.",
		},
		{
			ID:      "doc-2",
			Title:   strPtr("API Reference"),
			Path:    "docs/api.md",
			Summary: strPtr("Full API specifications."),
			Content: "# API Reference\nComprehensive API details.\n```typescript\nfunction start(): void {}\n```",
		},
		{
			ID:      "doc-3",
			Title:   strPtr("Migration Guide"),
			Path:    "docs/migration.md",
			Summary: strPtr("Upgrading from v1 to v2."),
			Content: "# Migration Guide\nStep by step migration instructions.",
		},
		{
			ID:      "doc-4",
			Title:   strPtr("Unlisted Guide"),
			Path:    "docs/unlisted.md",
			Summary: strPtr("Guide not present in nav tree."),
			Content: "# Unlisted Guide\nDetails not in nav.",
		},
	}

	tests := []struct {
		name           string
		token          string
		store          LlmsTxtStore
		body           any
		expectedStatus int
		verifyResponse func(t *testing.T, resp LlmsTxtResponse)
	}{
		{
			name:           "unauthorized request without token",
			token:          "",
			store:          &mockLlmsTxtStore{repoInfo: defaultRepoInfo, docs: defaultDocs},
			body:           LlmsTxtRequest{RepositoryID: "r1", Owner: "test-owner", Repo: "test-repo", BaseURL: "https://example.com"},
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "invalid token rejected",
			token:          "wrong-token",
			store:          &mockLlmsTxtStore{repoInfo: defaultRepoInfo, docs: defaultDocs},
			body:           LlmsTxtRequest{RepositoryID: "r1", Owner: "test-owner", Repo: "test-repo", BaseURL: "https://example.com"},
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "invalid json body returns 400",
			token:          validToken,
			store:          &mockLlmsTxtStore{repoInfo: defaultRepoInfo, docs: defaultDocs},
			body:           "not a valid json object",
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "missing repositoryId returns 400",
			token:          validToken,
			store:          &mockLlmsTxtStore{repoInfo: defaultRepoInfo, docs: defaultDocs},
			body:           LlmsTxtRequest{Owner: "test-owner", Repo: "test-repo"},
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "store unavailable returns 503",
			token:          validToken,
			store:          nil,
			body:           LlmsTxtRequest{RepositoryID: "r1", Owner: "test-owner", Repo: "test-repo", BaseURL: "https://example.com"},
			expectedStatus: http.StatusServiceUnavailable,
		},
		{
			name:           "repository not found returns 404",
			token:          validToken,
			store:          &mockLlmsTxtStore{err: errors.New("repository not found: r1")},
			body:           LlmsTxtRequest{RepositoryID: "r1", Owner: "test-owner", Repo: "test-repo", BaseURL: "https://example.com"},
			expectedStatus: http.StatusNotFound,
		},
		{
			name:  "basic mode full=false generates index only",
			token: validToken,
			store: &mockLlmsTxtStore{repoInfo: defaultRepoInfo, docs: defaultDocs},
			body: LlmsTxtRequest{
				RepositoryID: "r1",
				Owner:        "test-owner",
				Repo:         "test-repo",
				BaseURL:      "https://example.com",
				Full:         false,
			},
			expectedStatus: http.StatusOK,
			verifyResponse: func(t *testing.T, resp LlmsTxtResponse) {
				t.Helper()
				assert.Contains(t, resp.Content, "# test-owner/test-repo (v2.0.0) Documentation")
				assert.Contains(t, resp.Content, "(Web Framework)")
				assert.Contains(t, resp.Content, "## Docs")
				assert.Contains(t, resp.Content, "- [Getting Started](https://example.com/api/docs-content/test-owner/test-repo/docs/intro.md): Introduction to the framework.")
				assert.Contains(t, resp.Content, "- [Migration Guide](https://example.com/api/docs-content/test-owner/test-repo/docs/migration.md): Upgrading from v1 to v2.")
				assert.Contains(t, resp.Content, "- [Unlisted Guide](https://example.com/api/docs-content/test-owner/test-repo/docs/unlisted.md): Guide not present in nav tree.")
				assert.NotContains(t, resp.Content, "## Full Documentation Content")
				assert.Equal(t, 0, resp.DowngradedCount)
				assert.Equal(t, "v2.0.0", resp.TargetVersion)
				assert.Positive(t, resp.EstimatedTokens)
			},
		},
		{
			name:  "full mode full=true includes document bodies",
			token: validToken,
			store: &mockLlmsTxtStore{repoInfo: defaultRepoInfo, docs: defaultDocs},
			body: LlmsTxtRequest{
				RepositoryID: "r1",
				Owner:        "test-owner",
				Repo:         "test-repo",
				BaseURL:      "https://example.com",
				Full:         true,
			},
			expectedStatus: http.StatusOK,
			verifyResponse: func(t *testing.T, resp LlmsTxtResponse) {
				t.Helper()
				assert.Contains(t, resp.Content, "## Full Documentation Content")
				assert.Contains(t, resp.Content, "# Getting Started\n> Source Path: docs/intro.md")
				assert.Contains(t, resp.Content, "Welcome to the framework.")
				assert.Contains(t, resp.Content, "# Migration Guide\n> Source Path: docs/migration.md")
				assert.Equal(t, 0, resp.DowngradedCount)
				assert.Positive(t, resp.EstimatedTokens)
			},
		},
		{
			name:  "tier priority ordering puts Tier 0 migration ahead of Tier 1 guide and Tier 2 API",
			token: validToken,
			store: &mockLlmsTxtStore{repoInfo: defaultRepoInfo, docs: defaultDocs},
			body: LlmsTxtRequest{
				RepositoryID: "r1",
				Owner:        "test-owner",
				Repo:         "test-repo",
				BaseURL:      "https://example.com",
				Full:         true,
			},
			expectedStatus: http.StatusOK,
			verifyResponse: func(t *testing.T, resp LlmsTxtResponse) {
				t.Helper()
				// Tier 0 (migration) should appear before Tier 1 (intro/unlisted) and Tier 2 (api) in Full Documentation Content
				fullSectionIndex := strings.Index(resp.Content, "## Full Documentation Content")
				require.True(t, fullSectionIndex > 0)
				fullContent := resp.Content[fullSectionIndex:]

				migrationIdx := strings.Index(fullContent, "# Migration Guide")
				introIdx := strings.Index(fullContent, "# Getting Started")
				apiIdx := strings.Index(fullContent, "# API Reference")

				assert.True(t, migrationIdx < introIdx, "Tier 0 (migration) should precede Tier 1 (intro)")
				assert.True(t, introIdx < apiIdx, "Tier 1 (intro) should precede Tier 2 (api)")
			},
		},
		{
			name:  "topic boosting prioritizes matching document within same tier",
			token: validToken,
			store: &mockLlmsTxtStore{repoInfo: defaultRepoInfo, docs: defaultDocs},
			body: LlmsTxtRequest{
				RepositoryID: "r1",
				Owner:        "test-owner",
				Repo:         "test-repo",
				BaseURL:      "https://example.com",
				Full:         false,
				Topic:        strPtr("unlisted"),
			},
			expectedStatus: http.StatusOK,
			verifyResponse: func(t *testing.T, resp LlmsTxtResponse) {
				t.Helper()
				// In Tier 1 (Getting Started vs Unlisted Guide), topic "unlisted" should lift Unlisted Guide first
				docsIndex := strings.Index(resp.Content, "## Docs")
				require.True(t, docsIndex > 0)
				docsSection := resp.Content[docsIndex:]

				unlistedIdx := strings.Index(docsSection, "[Unlisted Guide]")
				introIdx := strings.Index(docsSection, "[Getting Started]")
				assert.True(t, unlistedIdx < introIdx, "Topic matching document should precede non-matching document in same tier")
			},
		},
		{
			name:  "strict mode budget truncation with notice",
			token: validToken,
			store: &mockLlmsTxtStore{repoInfo: defaultRepoInfo, docs: defaultDocs},
			body: LlmsTxtRequest{
				RepositoryID: "r1",
				Owner:        "test-owner",
				Repo:         "test-repo",
				BaseURL:      "https://example.com",
				Full:         true,
				Budget:       intPtr(180),
				Mode:         strPtr("strict"),
			},
			expectedStatus: http.StatusOK,
			verifyResponse: func(t *testing.T, resp LlmsTxtResponse) {
				t.Helper()
				assert.Contains(t, resp.Content, "> ⚠️ [Budget Strict Mode] Token budget of 180 reached.")
			},
		},
		{
			name:  "balanced mode auto-downgrade to summary",
			token: validToken,
			store: &mockLlmsTxtStore{
				repoInfo: defaultRepoInfo,
				docs: []LlmsTxtDoc{
					{
						ID:      "doc-1",
						Title:   strPtr("Huge Migration Guide"),
						Path:    "docs/migration.md",
						Summary: strPtr("Upgrading to v2."),
						Content: "# Huge Migration Guide\n" + strings.Repeat("Long detailed paragraph explaining migration breaking changes in depth. ", 10),
					},
					{
						ID:      "doc-2",
						Title:   strPtr("Next Steps"),
						Path:    "docs/next.md",
						Summary: strPtr("Next steps."),
						Content: "# Next Steps\nFollow up reading.",
					},
				},
			},
			body: LlmsTxtRequest{
				RepositoryID: "r1",
				Owner:        "test-owner",
				Repo:         "test-repo",
				BaseURL:      "https://example.com",
				Full:         true,
				Budget:       intPtr(180),
				Mode:         strPtr("balanced"),
			},
			expectedStatus: http.StatusOK,
			verifyResponse: func(t *testing.T, resp LlmsTxtResponse) {
				t.Helper()
				assert.Contains(t, resp.Content, "[Auto-Downgraded to Summary]")
				assert.Positive(t, resp.DowngradedCount)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := NewHandler(Config{}, nil, nil).WithLlmsStore(tt.store)
			mux := http.NewServeMux()
			mux.HandleFunc("POST /v1/llms-txt/generate", func(w http.ResponseWriter, r *http.Request) {
				token := r.Header.Get("x-internal-token")
				if token != validToken {
					w.WriteHeader(http.StatusUnauthorized)
					_ = json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
					return
				}
				h.HandleLlmsTxtGenerate(w, r)
			})

			var bodyBytes []byte
			switch v := tt.body.(type) {
			case string:
				bodyBytes = []byte(v)
			default:
				var err error
				bodyBytes, err = json.Marshal(v)
				require.NoError(t, err)
			}

			req := httptest.NewRequest(http.MethodPost, "/v1/llms-txt/generate", bytes.NewReader(bodyBytes))
			req.Header.Set("Content-Type", "application/json")
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}

			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			assert.Equal(t, tt.expectedStatus, rec.Code)

			if tt.expectedStatus == http.StatusOK && tt.verifyResponse != nil {
				var resp LlmsTxtResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				tt.verifyResponse(t, resp)
			}
		})
	}
}

func TestLlmsTxtFreezeDeduplication(t *testing.T) {
	sharedDoc := LlmsTxtDoc{
		ID:          "shared-1",
		Title:       strPtr("Shared Doc"),
		Path:        "docs/guide.md",
		Summary:     strPtr("Shared summary"),
		Content:     "Shared content",
		OwnerUserID: nil,
	}
	userDoc := LlmsTxtDoc{
		ID:          "user-1",
		Title:       strPtr("User Customized Doc"),
		Path:        "docs/guide.md",
		Summary:     strPtr("User customized summary"),
		Content:     "User customized content",
		OwnerUserID: strPtr("user-123"),
	}

	tests := []struct {
		name    string
		navTree string
		docs    []LlmsTxtDoc
	}{
		{
			name:    "shared then user doc without navTree",
			navTree: "",
			docs:    []LlmsTxtDoc{sharedDoc, userDoc},
		},
		{
			name:    "user then shared doc without navTree",
			navTree: "",
			docs:    []LlmsTxtDoc{userDoc, sharedDoc},
		},
		{
			name:    "shared then user doc with navTree",
			navTree: `[{"title":"Guide","path":"docs/guide.md"}]`,
			docs:    []LlmsTxtDoc{sharedDoc, userDoc},
		},
		{
			name:    "user then shared doc with navTree",
			navTree: `[{"title":"Guide","path":"docs/guide.md"}]`,
			docs:    []LlmsTxtDoc{userDoc, sharedDoc},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repoInfo := &LlmsTxtRepoInfo{
				Owner:   "test-owner",
				Repo:    "test-repo",
				Branch:  "main",
				NavTree: []byte(tt.navTree),
			}

			resp, err := GenerateLlmsTxt(LlmsTxtRequest{
				RepositoryID: "r1",
				Owner:        "test-owner",
				Repo:         "test-repo",
				BaseURL:      "https://example.com",
				Full:         true,
			}, repoInfo, tt.docs)

			require.NoError(t, err)
			assert.Contains(t, resp.Content, "User Customized Doc")
			assert.Contains(t, resp.Content, "User customized content")
			assert.NotContains(t, resp.Content, "Shared Doc")
			assert.NotContains(t, resp.Content, "Shared content")
			assert.Equal(t, 2, strings.Count(resp.Content, "docs/guide.md"))
		})
	}
}

func TestGenerateLlmsTxtWithOutlineProjectedNavTree(t *testing.T) {
	doc1 := LlmsTxtDoc{
		ID:      "d-1",
		Title:   strPtr("Intro Chapter"),
		Path:    "docs/intro.md",
		Summary: strPtr("Intro summary"),
		Content: "Content of intro",
	}
	doc2 := LlmsTxtDoc{
		ID:      "d-2",
		Title:   strPtr("Advanced Chapter"),
		Path:    "docs/advanced.md",
		Summary: strPtr("Advanced summary"),
		Content: "Content of advanced",
	}
	doc3 := LlmsTxtDoc{
		ID:      "d-3",
		Title:   strPtr("Unlisted Appendix"),
		Path:    "docs/appendix.md",
		Summary: strPtr("Appendix summary"),
		Content: "Content of appendix",
	}

	tests := []struct {
		name          string
		projectedTree string
		docs          []LlmsTxtDoc
		wantOrder     []string
	}{
		{
			name: "projected outline puts advanced before intro",
			projectedTree: `[
				{"name": "advanced.md", "title": "Advanced Chapter", "type": "file", "path": "docs/advanced.md"},
				{"name": "intro.md", "title": "Intro Chapter", "type": "file", "path": "docs/intro.md"}
			]`,
			docs:      []LlmsTxtDoc{doc1, doc2, doc3},
			wantOrder: []string{"docs/advanced.md", "docs/intro.md", "docs/appendix.md"},
		},
		{
			name: "nested part and chapter projected tree maintains teaching order",
			projectedTree: `[
				{
					"name": "Part 1",
					"title": "Part 1",
					"type": "directory",
					"children": [
						{"name": "intro.md", "title": "Intro Chapter", "type": "file", "path": "docs/intro.md"}
					]
				},
				{
					"name": "Part 2",
					"title": "Part 2",
					"type": "directory",
					"children": [
						{"name": "advanced.md", "title": "Advanced Chapter", "type": "file", "path": "docs/advanced.md"}
					]
				}
			]`,
			docs:      []LlmsTxtDoc{doc2, doc1},
			wantOrder: []string{"docs/intro.md", "docs/advanced.md"},
		},
		{
			name:          "null or empty projected tree preserves documents gracefully",
			projectedTree: `null`,
			docs:          []LlmsTxtDoc{doc1, doc2},
			wantOrder:     []string{"docs/intro.md", "docs/advanced.md"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repoInfo := &LlmsTxtRepoInfo{
				Owner:   "acme",
				Repo:    "projector-app",
				Branch:  "main",
				NavTree: []byte(tt.projectedTree),
			}

			resp, err := GenerateLlmsTxt(LlmsTxtRequest{
				RepositoryID: "r-project",
				Owner:        "acme",
				Repo:         "projector-app",
				BaseURL:      "https://docs.acme.com",
				Full:         false,
			}, repoInfo, tt.docs)

			require.NoError(t, err)
			var lastIdx int
			for _, expectedPath := range tt.wantOrder {
				idx := strings.Index(resp.Content, expectedPath)
				require.True(t, idx >= 0, "path %s must be present in llms.txt", expectedPath)
				assert.True(t, idx >= lastIdx, "path %s should appear after previous element", expectedPath)
				lastIdx = idx
			}
		})
	}
}
