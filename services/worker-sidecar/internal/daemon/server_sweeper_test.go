package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/scheduler"
)

type mockServerSweeperStore struct {
	reapedImportJobs int64
	cleanedLeases    int64
}

func (m *mockServerSweeperStore) ReapStaleImportJobs(_ context.Context, _ time.Time) (int64, error) {
	return m.reapedImportJobs, nil
}

func (m *mockServerSweeperStore) GcFinishedImportJobs(_ context.Context, _ time.Time) (int64, error) {
	return 0, nil
}

func (m *mockServerSweeperStore) ReapStaleTranscriptionJobs(_ context.Context, _ time.Time) (int64, error) {
	return 0, nil
}

func (m *mockServerSweeperStore) ReleaseExpiredClaims(context.Context) (int64, error) {
	return 0, nil
}

func (m *mockServerSweeperStore) FailTrialsWithoutStaging(context.Context) (int64, error) {
	return 0, nil
}

func (m *mockServerSweeperStore) CleanExpiredLeases(_ context.Context, _ time.Time) (int64, error) {
	return m.cleanedLeases, nil
}

// 🧪 [5.7.5.3] /v1/sweeper/run 内部端点鉴权与报表响应单测
func TestHandleSweeperRun_AuthAndResponse(t *testing.T) {
	tests := []struct {
		name           string
		token          string
		cfgToken       string
		configureStore bool
		wantStatus     int
		wantOk         bool
	}{
		{
			name:           "缺少 x-internal-token 头拒绝访问 (401)",
			token:          "",
			cfgToken:       "secret-sidecar-token",
			configureStore: true,
			wantStatus:     http.StatusForbidden,
			wantOk:         false,
		},
		{
			name:           "错误 x-internal-token 头拒绝访问 (401)",
			token:          "invalid-wrong-token",
			cfgToken:       "secret-sidecar-token",
			configureStore: true,
			wantStatus:     http.StatusForbidden,
			wantOk:         false,
		},
		{
			name:           "有效 x-internal-token 且 store 就绪返回 200 与清扫报表",
			token:          "secret-sidecar-token",
			cfgToken:       "secret-sidecar-token",
			configureStore: true,
			wantStatus:     http.StatusOK,
			wantOk:         true,
		},
		{
			name:           "store 未配置时优雅返回 503 Service Unavailable",
			token:          "secret-sidecar-token",
			cfgToken:       "secret-sidecar-token",
			configureStore: false,
			wantStatus:     http.StatusServiceUnavailable,
			wantOk:         false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Config{InternalToken: tt.cfgToken}
			s := &Server{cfg: cfg}
			if tt.configureStore {
				m := &mockServerSweeperStore{
					reapedImportJobs: 2,
					cleanedLeases:    3,
				}
				s.sweeperStore = m
			}

			handler := s.internal(s.handleSweeperRun)
			req := httptest.NewRequest(http.MethodPost, "/v1/sweeper/run", nil)
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			rec := httptest.NewRecorder()

			handler(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code, "HTTP status should match")

			if tt.wantOk {
				var resp struct {
					OK     bool                        `json:"ok"`
					Report scheduler.OrphanSweepReport `json:"report"`
				}
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err, "response body should be valid JSON")
				assert.True(t, resp.OK)
				assert.Equal(t, int64(2), resp.Report.ReapedImportJobs)
				assert.Equal(t, int64(3), resp.Report.ExpiredLeasesCleaned)
			}
		})
	}
}
