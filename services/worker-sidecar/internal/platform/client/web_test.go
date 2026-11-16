package client

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestImportRewardCallbackContract(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		body    string
		wantErr bool
	}{
		{"success", http.StatusOK, `{"ok":true}`, false},
		{"rejected", http.StatusOK, `{"ok":false}`, true},
		{"bad request retries", http.StatusBadRequest, `{"ok":false}`, true},
		{"forbidden retries", http.StatusForbidden, `{"ok":false}`, true},
		{"server error retries", http.StatusInternalServerError, `{"ok":false}`, true},
		{"invalid response retries", http.StatusOK, `not json`, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, http.MethodPost, r.Method)
				assert.Equal(t, importRewardPath, r.URL.Path)
				assert.Equal(t, "internal-secret", r.Header.Get("x-internal-token"))
				var body map[string]string
				assert.NoError(t, json.NewDecoder(r.Body).Decode(&body))
				assert.Equal(t, map[string]string{"jobId": "job-only"}, body)
				w.WriteHeader(tt.status)
				_, _ = io.WriteString(w, tt.body)
			}))
			defer server.Close()
			err := NewInternalWebClient(server.URL, "internal-secret").GrantImportReward(context.Background(), "job-only")
			if tt.wantErr {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
		})
	}
}


func TestInternalWebClientAutoUpdateOnce(t *testing.T) {
	tests := []struct {
		name        string
		statusCode  int
		response    map[string]any
		wantErr     bool
		errContains string
	}{
		{
			name:       "successful auto update",
			statusCode: http.StatusOK,
			response:   map[string]any{"ok": true},
			wantErr:    false,
		},
		{
			name:        "endpoint returns failure",
			statusCode:  http.StatusOK,
			response:    map[string]any{"ok": false, "message": "lease denied"},
			wantErr:     true,
			errContains: "lease denied",
		},
		{
			name:        "http 500 error",
			statusCode:  http.StatusInternalServerError,
			response:    map[string]any{"ok": false, "message": "db error"},
			wantErr:     true,
			errContains: "HTTP 500",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotToken, gotPath string

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotToken = r.Header.Get("x-internal-token")
				gotPath = r.URL.Path

				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tt.statusCode)
				_ = json.NewEncoder(w).Encode(tt.response)
			}))
			defer server.Close()

			client := NewInternalWebClient(server.URL, "secret-token")
			err := client.RunMarketEngineTick(context.Background())

			assert.Equal(t, "/api/internal/scheduler/auto-update-once", gotPath)
			assert.Equal(t, "secret-token", gotToken)

			if tt.wantErr {
				require.Error(t, err)
				if tt.errContains != "" {
					assert.Contains(t, err.Error(), tt.errContains)
				}
			} else {
				require.NoError(t, err)
			}
		})
	}
}

func TestInternalWebClientRevalidateRepository(t *testing.T) {
	tests := []struct {
		name        string
		repoId      string
		statusCode  int
		response    map[string]any
		wantErr     bool
		errContains string
	}{
		{
			name:       "successful revalidate",
			repoId:     "repo-123",
			statusCode: http.StatusOK,
			response:   map[string]any{"ok": true, "repositoryIds": 1},
			wantErr:    false,
		},
		{
			name:        "failed revalidate response not ok",
			repoId:      "repo-456",
			statusCode:  http.StatusOK,
			response:    map[string]any{"ok": false, "message": "unauthorized"},
			wantErr:     true,
			errContains: "unauthorized",
		},
		{
			name:        "http 500 server error",
			repoId:      "repo-789",
			statusCode:  http.StatusInternalServerError,
			response:    map[string]any{"error": "internal error"},
			wantErr:     true,
			errContains: "HTTP 500",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotToken, gotPath string
			var gotBody map[string]any

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotToken = r.Header.Get("x-internal-token")
				gotPath = r.URL.Path
				bodyBytes, _ := io.ReadAll(r.Body)
				_ = json.Unmarshal(bodyBytes, &gotBody)

				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tt.statusCode)
				_ = json.NewEncoder(w).Encode(tt.response)
			}))
			defer server.Close()

			client := NewInternalWebClient(server.URL, "secret-token")
			err := client.RevalidateRepository(context.Background(), tt.repoId)

			assert.Equal(t, "/api/internal/revalidate", gotPath)
			assert.Equal(t, "secret-token", gotToken)
			repoIds, ok := gotBody["repositoryIds"].([]any)
			require.True(t, ok)
			require.Len(t, repoIds, 1)
			assert.Equal(t, tt.repoId, repoIds[0])

			if tt.wantErr {
				require.Error(t, err)
				if tt.errContains != "" {
					assert.Contains(t, err.Error(), tt.errContains)
				}
			} else {
				require.NoError(t, err)
			}
		})
	}
}
