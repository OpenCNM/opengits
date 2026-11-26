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

func TestHandleUserModelProvidersList(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockProviders  []UserModelProviderView
		mockErr        error
		expectedStatus int
		expectedOk     bool
	}{
		{
			name:           "missing userId returns 401",
			body:           `{}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name: "successful list returns 200",
			body: `{"userId":"user-1"}`,
			mockProviders: []UserModelProviderView{
				{
					ID:          "p-1",
					ProviderKey: "openai",
					Name:        "OpenAI",
					IsActive:    true,
				},
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &mockStore{
				listUserModelProvidersFn: func(ctx context.Context, userID string) ([]UserModelProviderView, error) {
					if tt.mockErr != nil {
						return nil, tt.mockErr
					}
					return tt.mockProviders, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/user/model-providers/list", bytes.NewBufferString(tt.body))
			req.Header.Set("content-type", "application/json")
			w := httptest.NewRecorder()

			h.HandleUserModelProvidersList(w, req)
			assert.Equal(t, tt.expectedStatus, w.Code)

			var resp UserModelProvidersListResponse
			err := json.Unmarshal(w.Body.Bytes(), &resp)
			require.NoError(t, err)
			assert.Equal(t, tt.expectedOk, resp.Ok)
			if tt.expectedOk {
				assert.Equal(t, len(tt.mockProviders), len(resp.Providers))
			}
		})
	}
}

func TestHandleUserModelProviderUpsert(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockProvider   *UserModelProviderView
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCode   string
	}{
		{
			name:           "missing userId returns 401",
			body:           `{"providerKey":"openai"}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name:           "missing providerKey returns 400",
			body:           `{"userId":"user-1"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "api key required error returns 400",
			body:           `{"userId":"user-1","providerKey":"openai","name":"OpenAI","baseUrl":"https://api.openai.com/v1"}`,
			mockErr:        ErrApiKeyRequired,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
			expectedCode:   "API_KEY_REQUIRED",
		},
		{
			name: "successful upsert returns 200",
			body: `{"userId":"user-1","providerKey":"openai","name":"OpenAI","baseUrl":"https://api.openai.com/v1","encryptedApiKey":"enc:v1:test"}`,
			mockProvider: &UserModelProviderView{
				ID:          "p-1",
				ProviderKey: "openai",
				Name:        "OpenAI",
				IsActive:    true,
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &mockStore{
				upsertUserModelProviderFn: func(ctx context.Context, input UserModelProviderUpsertInput) (*UserModelProviderView, error) {
					if tt.mockErr != nil {
						return nil, tt.mockErr
					}
					return tt.mockProvider, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/user/model-providers/upsert", bytes.NewBufferString(tt.body))
			req.Header.Set("content-type", "application/json")
			w := httptest.NewRecorder()

			h.HandleUserModelProviderUpsert(w, req)
			assert.Equal(t, tt.expectedStatus, w.Code)

			var resp UserModelProviderUpsertResponse
			err := json.Unmarshal(w.Body.Bytes(), &resp)
			require.NoError(t, err)
			assert.Equal(t, tt.expectedOk, resp.Ok)
			if tt.expectedCode != "" {
				assert.Equal(t, tt.expectedCode, resp.Code)
			}
		})
	}
}

func TestHandleUserModelProviderPatch(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockProvider   *UserModelProviderView
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCode   string
	}{
		{
			name:           "missing userId returns 401",
			body:           `{"providerKey":"openai"}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name:           "missing providerKey returns 400",
			body:           `{"userId":"user-1"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "provider not found returns 404",
			body:           `{"userId":"user-1","providerKey":"unknown","makeActive":true}`,
			mockErr:        ErrProviderNotFound,
			expectedStatus: http.StatusNotFound,
			expectedOk:     false,
			expectedCode:   "PROVIDER_NOT_FOUND",
		},
		{
			name: "successful patch returns 200",
			body: `{"userId":"user-1","providerKey":"openai","makeActive":true}`,
			mockProvider: &UserModelProviderView{
				ID:          "p-1",
				ProviderKey: "openai",
				Name:        "OpenAI",
				IsActive:    true,
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &mockStore{
				patchUserModelProviderFn: func(ctx context.Context, input UserModelProviderPatchInput) (*UserModelProviderView, error) {
					if tt.mockErr != nil {
						return nil, tt.mockErr
					}
					return tt.mockProvider, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/user/model-providers/patch", bytes.NewBufferString(tt.body))
			req.Header.Set("content-type", "application/json")
			w := httptest.NewRecorder()

			h.HandleUserModelProviderPatch(w, req)
			assert.Equal(t, tt.expectedStatus, w.Code)

			var resp UserModelProviderPatchResponse
			err := json.Unmarshal(w.Body.Bytes(), &resp)
			require.NoError(t, err)
			assert.Equal(t, tt.expectedOk, resp.Ok)
			if tt.expectedCode != "" {
				assert.Equal(t, tt.expectedCode, resp.Code)
			}
		})
	}
}

func TestHandleUserModelProviderDelete(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockErr        error
		expectedStatus int
		expectedOk     bool
	}{
		{
			name:           "missing userId returns 401",
			body:           `{"providerKey":"openai"}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name:           "missing providerKey returns 400",
			body:           `{"userId":"user-1"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "successful deletion returns 200",
			body:           `{"userId":"user-1","providerKey":"openai"}`,
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &mockStore{
				deleteUserModelProviderFn: func(ctx context.Context, input UserModelProviderDeleteInput) error {
					return tt.mockErr
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/user/model-providers/delete", bytes.NewBufferString(tt.body))
			req.Header.Set("content-type", "application/json")
			w := httptest.NewRecorder()

			h.HandleUserModelProviderDelete(w, req)
			assert.Equal(t, tt.expectedStatus, w.Code)

			var resp UserModelProviderDeleteResponse
			err := json.Unmarshal(w.Body.Bytes(), &resp)
			require.NoError(t, err)
			assert.Equal(t, tt.expectedOk, resp.Ok)
			if tt.expectedOk {
				assert.True(t, resp.Deleted)
			}
		})
	}
}

func TestHandleUserModelProviderGetCipher(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockCipher     string
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedCode   string
	}{
		{
			name:           "missing userId returns 401",
			body:           `{"providerKey":"openai"}`,
			expectedStatus: http.StatusUnauthorized,
			expectedOk:     false,
		},
		{
			name:           "missing providerKey returns 400",
			body:           `{"userId":"user-1"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "provider not found returns 404",
			body:           `{"userId":"user-1","providerKey":"unknown"}`,
			mockErr:        ErrProviderNotFound,
			expectedStatus: http.StatusNotFound,
			expectedOk:     false,
			expectedCode:   "PROVIDER_NOT_FOUND",
		},
		{
			name:           "successful cipher retrieval returns 200",
			body:           `{"userId":"user-1","providerKey":"openai"}`,
			mockCipher:     "enc:v1:cipher_12345",
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &mockStore{
				getUserModelProviderCipherFn: func(ctx context.Context, userID, providerKey string) (string, error) {
					if tt.mockErr != nil {
						return "", tt.mockErr
					}
					return tt.mockCipher, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/user/model-providers/get-cipher", bytes.NewBufferString(tt.body))
			req.Header.Set("content-type", "application/json")
			w := httptest.NewRecorder()

			h.HandleUserModelProviderGetCipher(w, req)
			assert.Equal(t, tt.expectedStatus, w.Code)

			var resp UserModelProviderGetCipherResponse
			err := json.Unmarshal(w.Body.Bytes(), &resp)
			require.NoError(t, err)
			assert.Equal(t, tt.expectedOk, resp.Ok)
			if tt.expectedCode != "" {
				assert.Equal(t, tt.expectedCode, resp.Code)
			} else if tt.expectedOk {
				assert.Equal(t, tt.mockCipher, resp.APIKey)
			}
		})
	}
}
