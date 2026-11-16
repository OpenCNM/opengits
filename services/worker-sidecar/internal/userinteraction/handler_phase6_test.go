package userinteraction

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHandleUsageSummary(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockSummary    *UsageSummaryResult
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCode   string
	}{
		{
			name: "valid user usage summary",
			body: `{"userId":"user-123"}`,
			mockSummary: &UsageSummaryResult{
				Tier:          "PRO",
				IsAdmin:       true,
				ReposUsed:     5,
				MaxRepos:      0,
				McpCallsToday: 42,
				DailyMcpCalls: 3000,
				Tokens30d:     150000,
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
		{
			name:           "missing userId",
			body:           `{}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "user not found",
			body:           `{"userId":"non-existent"}`,
			mockErr:        ErrUserNotFound,
			expectedStatus: http.StatusNotFound,
			expectedOk:     false,
			expectedCode:   "USER_NOT_FOUND",
		},
		{
			name:           "store internal error",
			body:           `{"userId":"user-err"}`,
			mockErr:        errors.New("db failure"),
			expectedStatus: http.StatusInternalServerError,
			expectedOk:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				getUsageSummaryFn: func(ctx context.Context, userID string) (*UsageSummaryResult, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockSummary, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/usage/summary", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.HandleUsageSummary(w, req)

			resp := w.Result()
			defer resp.Body.Close()

			assert.Equal(t, tc.expectedStatus, resp.StatusCode)

			var res UsageSummaryResponse
			err := json.NewDecoder(resp.Body).Decode(&res)
			require.NoError(t, err)

			assert.Equal(t, tc.expectedOk, res.Ok)
			if tc.expectedCode != "" {
				assert.Equal(t, tc.expectedCode, res.Code)
			}
			if tc.mockSummary != nil && tc.expectedOk {
				require.NotNil(t, res.Summary)
				assert.Equal(t, tc.mockSummary.Tier, res.Summary.Tier)
				assert.Equal(t, tc.mockSummary.IsAdmin, res.Summary.IsAdmin)
				assert.Equal(t, tc.mockSummary.ReposUsed, res.Summary.ReposUsed)
				assert.Equal(t, tc.mockSummary.Tokens30d, res.Summary.Tokens30d)
			}
		})
	}
}

func TestHandleDocumentContent(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockDoc        *DocumentContentResult
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCode   string
	}{
		{
			name: "valid document content retrieval",
			body: `{"repositoryId":"repo-1","candidatePaths":["intro.md","intro.mdx"]}`,
			mockDoc: &DocumentContentResult{
				Found:   true,
				ID:      "doc-1",
				Path:    "intro.md",
				Title:   "Intro",
				Status:  "PROCESSED",
				Content: "# Hello World\nContent",
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
		{
			name:           "missing repositoryId",
			body:           `{"candidatePaths":["intro.md"]}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "empty candidatePaths",
			body:           `{"repositoryId":"repo-1","candidatePaths":[]}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "document not found",
			body:           `{"repositoryId":"repo-1","candidatePaths":["notfound.md"]}`,
			mockErr:        ErrDocumentNotFound,
			expectedStatus: http.StatusNotFound,
			expectedOk:     false,
			expectedCode:   "DOCUMENT_NOT_FOUND",
		},
		{
			name:           "document content empty",
			body:           `{"repositoryId":"repo-1","candidatePaths":["empty.md"]}`,
			mockErr:        ErrDocumentContentEmpty,
			expectedStatus: http.StatusNotFound,
			expectedOk:     false,
			expectedCode:   "DOCUMENT_NOT_FOUND",
		},
		{
			name:           "store error",
			body:           `{"repositoryId":"repo-1","candidatePaths":["intro.md"]}`,
			mockErr:        errors.New("db error"),
			expectedStatus: http.StatusInternalServerError,
			expectedOk:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				getDocumentContentFn: func(ctx context.Context, repoID string, candidatePaths []string, userID *string) (*DocumentContentResult, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockDoc, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/documents/content", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.HandleDocumentContent(w, req)

			resp := w.Result()
			defer resp.Body.Close()

			assert.Equal(t, tc.expectedStatus, resp.StatusCode)

			var res DocumentContentResponse
			err := json.NewDecoder(resp.Body).Decode(&res)
			require.NoError(t, err)

			assert.Equal(t, tc.expectedOk, res.Ok)
			if tc.expectedCode != "" {
				assert.Equal(t, tc.expectedCode, res.Code)
			}
			if tc.mockDoc != nil && tc.expectedOk {
				require.NotNil(t, res.Document)
				assert.Equal(t, tc.mockDoc.ID, res.Document.ID)
				assert.Equal(t, tc.mockDoc.Content, res.Document.Content)
			}
		})
	}
}

func TestHandleChapterVersionsList(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockVersions   []ChapterVersionItem
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCount  int
	}{
		{
			name: "valid chapter versions list",
			body: `{"documentId":"doc-1","userId":"user-1"}`,
			mockVersions: []ChapterVersionItem{
				{
					ID:             "ver-1",
					AuthorID:       "user-1",
					VoteCount:      10,
					IsCanonical:    true,
					Visibility:     "PUBLIC",
					Source:         "ORIGINAL",
					CreatedAt:      "2026-09-21T00:00:00Z",
					HasVoted:       true,
					IsContentValid: true,
				},
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedCount:  1,
		},
		{
			name:           "missing documentId",
			body:           `{}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "store error",
			body:           `{"documentId":"doc-err"}`,
			mockErr:        errors.New("db failure"),
			expectedStatus: http.StatusInternalServerError,
			expectedOk:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				listChapterVersionsFn: func(ctx context.Context, docID string, userID *string) ([]ChapterVersionItem, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockVersions, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/chapter-versions/list", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.HandleChapterVersionsList(w, req)

			resp := w.Result()
			defer resp.Body.Close()

			assert.Equal(t, tc.expectedStatus, resp.StatusCode)

			var res ChapterVersionsListResponse
			err := json.NewDecoder(resp.Body).Decode(&res)
			require.NoError(t, err)

			assert.Equal(t, tc.expectedOk, res.Ok)
			if tc.expectedOk {
				assert.Len(t, res.Versions, tc.expectedCount)
			}
		})
	}
}
