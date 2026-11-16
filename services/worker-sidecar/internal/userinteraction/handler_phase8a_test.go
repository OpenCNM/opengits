package userinteraction

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHandleConversationCreate(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockConv       *ConversationRecord
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCode   string
	}{
		{
			name:           "missing userId returns 401",
			body:           `{"owner":"octocat","repo":"Hello-World"}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name:           "missing repo info returns 400",
			body:           `{"userId":"user-1"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "repository not found returns 404",
			body:           `{"userId":"user-1","owner":"ghost","repo":"nonexistent"}`,
			mockErr:        ErrRepositoryNotFound,
			expectedStatus: http.StatusNotFound,
			expectedOk:     false,
			expectedCode:   "NOT_FOUND",
		},
		{
			name:           "repository forbidden returns 403",
			body:           `{"userId":"user-1","owner":"private","repo":"secret"}`,
			mockErr:        ErrRepositoryForbidden,
			expectedStatus: http.StatusForbidden,
			expectedOk:     false,
			expectedCode:   "FORBIDDEN",
		},
		{
			name: "successful creation returns 200",
			body: `{"userId":"user-1","owner":"octocat","repo":"Hello-World","title":"My Chat"}`,
			mockConv: &ConversationRecord{
				ID:           "conv-1",
				UserID:       "user-1",
				RepositoryID: "repo-1",
				Title:        "My Chat",
				CreatedAt:    "2026-09-22T00:00:00Z",
				UpdatedAt:    "2026-09-22T00:00:00Z",
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				createConversationFn: func(ctx context.Context, input ConversationCreateInput) (*ConversationRecord, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockConv, nil
				},
			}

			h := NewHandler(store)
			req := httptest.NewRequest(http.MethodPost, "/v1/conversations/create", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.HandleConversationCreate(w, req)
			assert.Equal(t, tc.expectedStatus, w.Code)

			if tc.expectedOk {
				var resp ConversationCreateResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				require.NotNil(t, resp.Conversation)
				assert.Equal(t, tc.mockConv.ID, resp.Conversation.ID)
			} else if tc.expectedCode != "" {
				var resp ConversationCreateResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.False(t, resp.Ok)
				assert.Equal(t, tc.expectedCode, resp.Code)
			}
		})
	}
}

func TestHandleConversationUpdate(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockConv       *ConversationRecord
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCode   string
	}{
		{
			name:           "missing userId returns 401",
			body:           `{"id":"conv-1","title":"New Title"}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name:           "missing id returns 400",
			body:           `{"userId":"user-1","title":"New Title"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "empty title returns 400",
			body:           `{"userId":"user-1","id":"conv-1","title":"   "}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "conversation not found returns 404",
			body:           `{"userId":"user-1","id":"conv-999","title":"New Title"}`,
			mockErr:        ErrConversationNotFound,
			expectedStatus: http.StatusNotFound,
			expectedOk:     false,
			expectedCode:   "NOT_FOUND",
		},
		{
			name: "successful update returns 200",
			body: `{"userId":"user-1","id":"conv-1","title":"Renamed Chat"}`,
			mockConv: &ConversationRecord{
				ID:           "conv-1",
				UserID:       "user-1",
				RepositoryID: "repo-1",
				Title:        "Renamed Chat",
				CreatedAt:    "2026-09-22T00:00:00Z",
				UpdatedAt:    "2026-09-22T01:00:00Z",
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				updateConversationFn: func(ctx context.Context, input ConversationUpdateInput) (*ConversationRecord, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockConv, nil
				},
			}

			h := NewHandler(store)
			req := httptest.NewRequest(http.MethodPost, "/v1/conversations/update", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.HandleConversationUpdate(w, req)
			assert.Equal(t, tc.expectedStatus, w.Code)

			if tc.expectedOk {
				var resp ConversationUpdateResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				require.NotNil(t, resp.Conversation)
				assert.Equal(t, "Renamed Chat", resp.Conversation.Title)
			} else if tc.expectedCode != "" {
				var resp ConversationUpdateResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.False(t, resp.Ok)
				assert.Equal(t, tc.expectedCode, resp.Code)
			}
		})
	}
}

func TestHandleConversationDelete(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCode   string
	}{
		{
			name:           "missing userId returns 401",
			body:           `{"id":"conv-1"}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name:           "missing id returns 400",
			body:           `{"userId":"user-1"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "conversation not found returns 404",
			body:           `{"userId":"user-1","id":"conv-999"}`,
			mockErr:        ErrConversationNotFound,
			expectedStatus: http.StatusNotFound,
			expectedOk:     false,
			expectedCode:   "NOT_FOUND",
		},
		{
			name:           "successful delete returns 200",
			body:           `{"userId":"user-1","id":"conv-1"}`,
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				deleteConversationFn: func(ctx context.Context, input ConversationDeleteInput) error {
					return tc.mockErr
				},
			}

			h := NewHandler(store)
			req := httptest.NewRequest(http.MethodPost, "/v1/conversations/delete", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.HandleConversationDelete(w, req)
			assert.Equal(t, tc.expectedStatus, w.Code)

			if tc.expectedOk {
				var resp ConversationDeleteResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				assert.Equal(t, "Conversation deleted", resp.Message)
			} else if tc.expectedCode != "" {
				var resp ConversationDeleteResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.False(t, resp.Ok)
				assert.Equal(t, tc.expectedCode, resp.Code)
			}
		})
	}
}
