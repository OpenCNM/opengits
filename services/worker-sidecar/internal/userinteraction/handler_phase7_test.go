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

func TestHandleConversationsList(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockConvs      []ConversationSummary
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCode   string
		expectedCount  int
	}{
		{
			name: "successful conversations list",
			body: `{"owner":"facebook","repo":"react","userId":"user-1"}`,
			mockConvs: []ConversationSummary{
				{
					ID:        "conv-1",
					Title:     "Discussion 1",
					CreatedAt: "2026-09-21T00:00:00Z",
					UpdatedAt: "2026-09-21T01:00:00Z",
				},
				{
					ID:        "conv-2",
					Title:     "Discussion 2",
					CreatedAt: "2026-09-21T02:00:00Z",
					UpdatedAt: "2026-09-21T03:00:00Z",
				},
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedCount:  2,
		},
		{
			name:           "missing owner or repo",
			body:           `{"owner":"","repo":"react","userId":"user-1"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "missing userId",
			body:           `{"owner":"facebook","repo":"react","userId":""}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name:           "repo not found",
			body:           `{"owner":"facebook","repo":"nonexistent","userId":"user-1"}`,
			mockErr:        ErrRepositoryNotFound,
			expectedStatus: http.StatusNotFound,
			expectedOk:     false,
			expectedCode:   "NOT_FOUND",
		},
		{
			name:           "repo forbidden",
			body:           `{"owner":"facebook","repo":"private-repo","userId":"user-1"}`,
			mockErr:        ErrRepositoryForbidden,
			expectedStatus: http.StatusForbidden,
			expectedOk:     false,
			expectedCode:   "FORBIDDEN",
		},
		{
			name:           "store error",
			body:           `{"owner":"facebook","repo":"react","userId":"user-1"}`,
			mockErr:        errors.New("db error"),
			expectedStatus: http.StatusInternalServerError,
			expectedOk:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				listConversationsFn: func(ctx context.Context, owner, repo, userID string) ([]ConversationSummary, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockConvs, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/conversations/list", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.HandleConversationsList(w, req)

			resp := w.Result()
			defer resp.Body.Close()

			assert.Equal(t, tc.expectedStatus, resp.StatusCode)

			var res ConversationsListResponse
			err := json.NewDecoder(resp.Body).Decode(&res)
			require.NoError(t, err)

			assert.Equal(t, tc.expectedOk, res.Ok)
			if tc.expectedCode != "" {
				assert.Equal(t, tc.expectedCode, res.Code)
			}
			if tc.expectedOk {
				assert.Len(t, res.Conversations, tc.expectedCount)
			}
		})
	}
}

func TestHandleConversationMessages(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockMsgs       []ConversationMessageItem
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCode   string
		expectedCount  int
	}{
		{
			name: "successful messages retrieval with tool message",
			body: `{"conversationId":"conv-1","userId":"user-1"}`,
			mockMsgs: []ConversationMessageItem{
				{
					ID:        "msg-1",
					Role:      "user",
					Content:   "how do I use hooks?",
					CreatedAt: "2026-09-21T00:00:00Z",
				},
				{
					ID:   "msg-2",
					Role: "tool",
					Content: map[string]any{
						"result": "hooks explanation",
					},
					CreatedAt: "2026-09-21T00:01:00Z",
				},
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedCount:  2,
		},
		{
			name:           "missing conversationId",
			body:           `{"conversationId":"","userId":"user-1"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "missing userId",
			body:           `{"conversationId":"conv-1","userId":""}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name:           "conversation not found",
			body:           `{"conversationId":"conv-notfound","userId":"user-1"}`,
			mockErr:        ErrConversationNotFound,
			expectedStatus: http.StatusNotFound,
			expectedOk:     false,
			expectedCode:   "NOT_FOUND",
		},
		{
			name:           "store error",
			body:           `{"conversationId":"conv-1","userId":"user-1"}`,
			mockErr:        errors.New("db error"),
			expectedStatus: http.StatusInternalServerError,
			expectedOk:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				getConversationMessagesFn: func(ctx context.Context, conversationID, userID string) ([]ConversationMessageItem, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockMsgs, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/conversations/messages", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.HandleConversationMessages(w, req)

			resp := w.Result()
			defer resp.Body.Close()

			assert.Equal(t, tc.expectedStatus, resp.StatusCode)

			var res ConversationMessagesResponse
			err := json.NewDecoder(resp.Body).Decode(&res)
			require.NoError(t, err)

			assert.Equal(t, tc.expectedOk, res.Ok)
			if tc.expectedCode != "" {
				assert.Equal(t, tc.expectedCode, res.Code)
			}
			if tc.expectedOk {
				assert.Len(t, res.Messages, tc.expectedCount)
			}
		})
	}
}

func TestHandleUserPreferencesSet(t *testing.T) {
	lang := "zh"
	fontSize := "medium"
	tests := []struct {
		name           string
		body           string
		mockRecord     *UserPreferencesRecord
		mockErr        error
		expectedStatus int
		expectedOk     bool
	}{
		{
			name: "successful preferences set",
			body: `{"userId":"user-1","preferredLang1":"zh","fontSize":"medium","hasDisabledRepos":true,"disabledMcpRepoIds":["repo-1"]}`,
			mockRecord: &UserPreferencesRecord{
				ID:                 "user-1",
				PreferredLang1:     &lang,
				FontSize:           fontSize,
				HasPreferencesSet:  true,
				DisabledMcpRepoIds: []string{"repo-1"},
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
		{
			name:           "missing userId",
			body:           `{"fontSize":"small"}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name:           "store error",
			body:           `{"userId":"user-err"}`,
			mockErr:        errors.New("db write failed"),
			expectedStatus: http.StatusInternalServerError,
			expectedOk:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				setUserPreferencesFn: func(ctx context.Context, input UserPreferencesSetInput) (*UserPreferencesRecord, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockRecord, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/user/preferences/set", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.HandleUserPreferencesSet(w, req)

			resp := w.Result()
			defer resp.Body.Close()

			assert.Equal(t, tc.expectedStatus, resp.StatusCode)

			var res UserPreferencesSetResponse
			err := json.NewDecoder(resp.Body).Decode(&res)
			require.NoError(t, err)

			assert.Equal(t, tc.expectedOk, res.Ok)
			if tc.mockRecord != nil && tc.expectedOk {
				require.NotNil(t, res.User)
				assert.Equal(t, tc.mockRecord.ID, res.User.ID)
				assert.Equal(t, tc.mockRecord.FontSize, res.User.FontSize)
			}
		})
	}
}

func TestHandleMcpTokensList(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockTokens     []McpTokenSummary
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCount  int
	}{
		{
			name: "successful mcp tokens list",
			body: `{"userId":"user-1"}`,
			mockTokens: []McpTokenSummary{
				{
					ID:        "tok-1",
					Name:      "Claude Desktop",
					Prefix:    "mcp_abcd",
					CreatedAt: "2026-09-21T00:00:00Z",
				},
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedCount:  1,
		},
		{
			name:           "missing userId",
			body:           `{}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name:           "store error",
			body:           `{"userId":"user-err"}`,
			mockErr:        errors.New("db error"),
			expectedStatus: http.StatusInternalServerError,
			expectedOk:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				listMcpTokensFn: func(ctx context.Context, userID string) ([]McpTokenSummary, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockTokens, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/mcp/tokens/list", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.HandleMcpTokensList(w, req)

			resp := w.Result()
			defer resp.Body.Close()

			assert.Equal(t, tc.expectedStatus, resp.StatusCode)

			var res McpTokensListResponse
			err := json.NewDecoder(resp.Body).Decode(&res)
			require.NoError(t, err)

			assert.Equal(t, tc.expectedOk, res.Ok)
			if tc.expectedOk {
				assert.Len(t, res.Tokens, tc.expectedCount)
			}
		})
	}
}
