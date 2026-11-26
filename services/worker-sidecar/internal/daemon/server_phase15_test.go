package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opengits/worker-sidecar/internal/userinteraction"
	"github.com/stretchr/testify/assert"
)

type mockPhase15Store struct {
	userinteraction.Store
	notificationsCreated bool
	mcpTokenTouched      bool
	repoUnsaved          bool
	repoFollowed         bool
}

func (m *mockPhase15Store) CreateNotifications(ctx context.Context, items []userinteraction.CreateNotificationInput) error {
	m.notificationsCreated = true
	return nil
}

func (m *mockPhase15Store) TouchMcpTokenUsage(ctx context.Context, tokenID string) error {
	m.mcpTokenTouched = true
	return nil
}

func (m *mockPhase15Store) UnsaveRepo(ctx context.Context, userID, repositoryID string) error {
	m.repoUnsaved = true
	return nil
}

func (m *mockPhase15Store) SetSavedRepoFollow(ctx context.Context, userID, repositoryID string, autoFollow bool) (bool, error) {
	m.repoFollowed = true
	return true, nil
}

func TestServer_Phase15Endpoints(t *testing.T) {
	mockStore := &mockPhase15Store{}
	cfg := Config{
		InternalToken: "secret-token",
	}
	s := newServer(cfg, nil, nil, nil, nil)
	s.SetUserInteractionStore(mockStore)
	handler := s.routes()

	t.Run("POST /v1/notifications/create", func(t *testing.T) {
		body := map[string]any{
			"notifications": []map[string]any{
				{
					"userId": "usr-1",
					"type":   "test_notice",
					"title":  "Test Notice",
				},
			},
		}
		data, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", "/v1/notifications/create", bytes.NewReader(data))
		req.Header.Set("x-internal-token", "secret-token")
		w := httptest.NewRecorder()

		handler.ServeHTTP(w, req)
		assert.Equal(t, http.StatusOK, w.Code)
		assert.True(t, mockStore.notificationsCreated)
	})

	t.Run("POST /v1/mcp/tokens/touch", func(t *testing.T) {
		body := map[string]any{"id": "tok-123"}
		data, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", "/v1/mcp/tokens/touch", bytes.NewReader(data))
		req.Header.Set("x-internal-token", "secret-token")
		w := httptest.NewRecorder()

		handler.ServeHTTP(w, req)
		assert.Equal(t, http.StatusOK, w.Code)
		assert.True(t, mockStore.mcpTokenTouched)
	})

	t.Run("POST /v1/repos/unsave", func(t *testing.T) {
		body := map[string]any{"userId": "usr-1", "repositoryId": "repo-1"}
		data, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", "/v1/repos/unsave", bytes.NewReader(data))
		req.Header.Set("x-internal-token", "secret-token")
		w := httptest.NewRecorder()

		handler.ServeHTTP(w, req)
		assert.Equal(t, http.StatusOK, w.Code)
		assert.True(t, mockStore.repoUnsaved)
	})

	t.Run("POST /v1/repos/follow", func(t *testing.T) {
		body := map[string]any{"userId": "usr-1", "repositoryId": "repo-1", "autoFollow": true}
		data, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", "/v1/repos/follow", bytes.NewReader(data))
		req.Header.Set("x-internal-token", "secret-token")
		w := httptest.NewRecorder()

		handler.ServeHTTP(w, req)
		assert.Equal(t, http.StatusOK, w.Code)
		assert.True(t, mockStore.repoFollowed)
	})
}
