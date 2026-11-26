package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/opengits/worker-sidecar/internal/scheduler"
	"github.com/opengits/worker-sidecar/internal/userinteraction"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockGatewayTelemetryStore struct {
	userinteraction.Store
	presenceTouched  bool
	usageIncremented bool
	callLogRecorded  bool
	quotaRecorded    bool
	lastCallLogInput *userinteraction.McpCallLogInput
}

func (m *mockGatewayTelemetryStore) TouchMcpPresence(ctx context.Context, userID, clientName, clientVer, ip string) error {
	m.presenceTouched = true
	return nil
}

func (m *mockGatewayTelemetryStore) IncrementMcpUsage(ctx context.Context, userID, day string) error {
	m.usageIncremented = true
	return nil
}

func (m *mockGatewayTelemetryStore) RecordMcpCallLog(ctx context.Context, input userinteraction.McpCallLogInput) error {
	m.callLogRecorded = true
	m.lastCallLogInput = &input
	return nil
}

func (m *mockGatewayTelemetryStore) RecordGithubQuotaSample(ctx context.Context, input userinteraction.GithubQuotaSampleInput) error {
	m.quotaRecorded = true
	return nil
}

type mockLeaseTaskStore struct {
	scheduler.TaskStore
	acquireKey   string
	acquireOwner string
	releaseKey   string
	releaseOwner string
}

func (m *mockLeaseTaskStore) LeaseUpdateIfHeldOrExpired(ctx context.Context, key, owner string, until time.Time) (int64, error) {
	m.acquireKey = key
	m.acquireOwner = owner
	return 1, nil
}

func (m *mockLeaseTaskStore) LeaseInsert(ctx context.Context, key, owner string, until time.Time) error {
	return nil
}

func (m *mockLeaseTaskStore) LeaseDelete(ctx context.Context, key, owner string) error {
	m.releaseKey = key
	m.releaseOwner = owner
	return nil
}

func TestServer_GatewayAndTelemetryEndpoints(t *testing.T) {
	token := "test-internal-token-phase14"
	cfg := Config{InternalToken: token}
	s := newServer(cfg, nil, nil, nil, nil)

	mockStore := &mockGatewayTelemetryStore{}
	s.SetUserInteractionStore(mockStore)

	leaseStore := &mockLeaseTaskStore{}
	s.SetSchedulerStore(leaseStore)

	handler := s.routes()

	doPost := func(path string, body any, withToken bool) *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(data))
		req.Header.Set("content-type", "application/json")
		if withToken {
			req.Header.Set("x-internal-token", token)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	t.Run("auth guard rejects unauthenticated requests", func(t *testing.T) {
		rec := doPost("/v1/mcp/presence/touch", map[string]string{"userId": "u1", "clientName": "c1"}, false)
		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("mcp presence touch", func(t *testing.T) {
		rec := doPost("/v1/mcp/presence/touch", map[string]string{
			"userId":     "u-123",
			"clientName": "Cursor IDE",
			"clientVer":  "1.0.0",
			"ipAddress":  "127.0.0.1",
		}, true)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, mockStore.presenceTouched)
	})

	t.Run("mcp usage increment", func(t *testing.T) {
		rec := doPost("/v1/mcp/usage/increment", map[string]string{
			"userId": "u-123",
			"day":    "2026-09-22",
		}, true)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, mockStore.usageIncremented)
	})

	t.Run("mcp call log record", func(t *testing.T) {
		tests := []struct {
			name    string
			payload map[string]any
			verify  func(t *testing.T, input *userinteraction.McpCallLogInput)
		}{
			{
				name: "基础字段",
				payload: map[string]any{
					"toolName":       "search",
					"userId":         "u-123",
					"clientName":     "Cursor IDE",
					"resultCount":    3,
					"responseTimeMs": 45,
				},
				verify: func(t *testing.T, input *userinteraction.McpCallLogInput) {
					assert.Equal(t, "search", input.ToolName)
					assert.Nil(t, input.RequestedEdition)
					assert.False(t, input.IsFallback != nil && *input.IsFallback)
				},
			},
			{
				name: "讲法回退三件套透传",
				payload: map[string]any{
					"toolName":         "read",
					"userId":           "u-123",
					"resultCount":      1,
					"requestedEdition": "ed_deep",
					"resolvedEdition":  "",
					"isFallback":       true,
				},
				verify: func(t *testing.T, input *userinteraction.McpCallLogInput) {
					require.NotNil(t, input.RequestedEdition)
					assert.Equal(t, "ed_deep", *input.RequestedEdition)
					require.NotNil(t, input.IsFallback)
					assert.True(t, *input.IsFallback)
				},
			},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				rec := doPost("/v1/telemetry/mcp-call-log", tt.payload, true)
				assert.Equal(t, http.StatusOK, rec.Code)
				assert.True(t, mockStore.callLogRecorded)
				require.NotNil(t, mockStore.lastCallLogInput)
				tt.verify(t, mockStore.lastCallLogInput)
			})
		}
	})

	t.Run("github quota sample record", func(t *testing.T) {
		rec := doPost("/v1/github/quota/sample", map[string]any{
			"fingerprint":   "fp_test_123",
			"remaining":     4800,
			"endpointClass": "REST",
			"status":        200,
		}, true)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, mockStore.quotaRecorded)
	})

	t.Run("scheduler lease acquire", func(t *testing.T) {
		rec := doPost("/v1/scheduler/lease/acquire", map[string]any{
			"key":     "test-task",
			"ttlMs":   10000,
			"ownerId": "worker-node-1",
		}, true)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "test-task", leaseStore.acquireKey)
		assert.Equal(t, "worker-node-1", leaseStore.acquireOwner)
		var resp map[string]bool
		_ = json.NewDecoder(rec.Body).Decode(&resp)
		assert.True(t, resp["acquired"])
	})

	t.Run("scheduler lease release", func(t *testing.T) {
		rec := doPost("/v1/scheduler/lease/release", map[string]any{
			"key":     "test-task",
			"ownerId": "worker-node-1",
		}, true)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "test-task", leaseStore.releaseKey)
		assert.Equal(t, "worker-node-1", leaseStore.releaseOwner)
		var resp map[string]bool
		_ = json.NewDecoder(rec.Body).Decode(&resp)
		assert.True(t, resp["ok"])
	})
}
