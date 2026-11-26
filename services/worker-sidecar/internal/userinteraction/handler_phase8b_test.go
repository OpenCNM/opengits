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

func TestHandleMcpTokenCreate(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockToken      *McpTokenCreatedRecord
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCode   string
	}{
		{
			name:           "missing userId returns 401",
			body:           `{"name":"test-tok","tokenHash":"h123","prefix":"opgts_12"}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name:           "missing name returns 400",
			body:           `{"userId":"user-1","name":"   ","tokenHash":"h123","prefix":"opgts_12"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "missing tokenHash returns 400",
			body:           `{"userId":"user-1","name":"test-tok","prefix":"opgts_12"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "missing prefix returns 400",
			body:           `{"userId":"user-1","name":"test-tok","tokenHash":"h123"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "max tokens exceeded returns 409",
			body:           `{"userId":"user-1","name":"test-tok","tokenHash":"h123","prefix":"opgts_12"}`,
			mockErr:        ErrMaxTokensExceeded,
			expectedStatus: http.StatusConflict,
			expectedOk:     false,
			expectedCode:   "MAX_TOKENS_EXCEEDED",
		},
		{
			name: "successful creation returns 200",
			body: `{"userId":"user-1","name":"test-tok","tokenHash":"h123","prefix":"opgts_12"}`,
			mockToken: &McpTokenCreatedRecord{
				ID:        "tok-1",
				Name:      "test-tok",
				Prefix:    "opgts_12",
				CreatedAt: "2026-09-22T00:00:00Z",
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				createMcpTokenFn: func(ctx context.Context, input McpTokenCreateInput) (*McpTokenCreatedRecord, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockToken, nil
				},
			}

			h := NewHandler(store)
			req := httptest.NewRequest(http.MethodPost, "/v1/mcp/tokens/create", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.HandleMcpTokenCreate(w, req)
			assert.Equal(t, tc.expectedStatus, w.Code)

			if tc.expectedOk {
				var resp McpTokenCreateResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				require.NotNil(t, resp.Token)
				assert.Equal(t, tc.mockToken.ID, resp.Token.ID)
			} else if tc.expectedCode != "" {
				var resp McpTokenCreateResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.False(t, resp.Ok)
				assert.Equal(t, tc.expectedCode, resp.Code)
			}
		})
	}
}

func TestHandleMcpTokenRevoke(t *testing.T) {
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
			body:           `{"id":"tok-1"}`,
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
			name:           "token not found returns 404",
			body:           `{"userId":"user-1","id":"tok-missing"}`,
			mockErr:        ErrMcpTokenNotFound,
			expectedStatus: http.StatusNotFound,
			expectedOk:     false,
			expectedCode:   "TOKEN_NOT_FOUND",
		},
		{
			name:           "successful revocation returns 200",
			body:           `{"userId":"user-1","id":"tok-1"}`,
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
		{
			name:           "successful bulk revocation with all returns 200",
			body:           `{"userId":"user-1","all":true}`,
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				revokeMcpTokenFn: func(ctx context.Context, input McpTokenRevokeInput) (int64, error) {
					if tc.mockErr != nil {
						return 0, tc.mockErr
					}
					return 1, nil
				},
			}

			h := NewHandler(store)
			req := httptest.NewRequest(http.MethodPost, "/v1/mcp/tokens/revoke", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.HandleMcpTokenRevoke(w, req)
			assert.Equal(t, tc.expectedStatus, w.Code)

			if tc.expectedOk {
				var resp McpTokenRevokeResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				assert.True(t, resp.Revoked)
			} else if tc.expectedCode != "" {
				var resp McpTokenRevokeResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.False(t, resp.Ok)
				assert.Equal(t, tc.expectedCode, resp.Code)
			}
		})
	}
}
