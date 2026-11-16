package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─────────────────────────────────────────────────────────────
// 前端监控告警表驱动测试：双阈值触发语义 + webhook 未配置禁用 +
// 告警载荷字段契约（{"text", "errorSessions", "crashes", "window"}）。
// ─────────────────────────────────────────────────────────────

type webhookCapture struct {
	mu     sync.Mutex
	bodies []map[string]any
}

func newCaptureServer(t *testing.T) (*webhookCapture, *httptest.Server) {
	t.Helper()
	capture := &webhookCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		var parsed map[string]any
		require.NoError(t, json.Unmarshal(body, &parsed))
		capture.mu.Lock()
		capture.bodies = append(capture.bodies, parsed)
		capture.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return capture, srv
}

func TestRunMonitorAlertOnce(t *testing.T) {
	baseCfg := func(webhook string) Config {
		return Config{
			MonitorAlertWebhookURL:    webhook,
			MonitorAlertErrorSessions: 10,
			MonitorAlertCrashes:       3,
		}
	}

	tests := []struct {
		name             string
		webhookEnabled   bool
		errorSessions    int64
		crashes          int64
		expectNotified   bool
		expectTextSubstr string
	}{
		{
			name:           "webhook 未配置整体禁用",
			webhookEnabled: false,
			errorSessions:  999,
			crashes:        999,
			expectNotified: false,
		},
		{
			name:           "双阈值内静默",
			webhookEnabled: true,
			errorSessions:  9,
			crashes:        2,
			expectNotified: false,
		},
		{
			name:             "错误会话超阈值触发",
			webhookEnabled:   true,
			errorSessions:    11,
			crashes:          0,
			expectNotified:   true,
			expectTextSubstr: "错误会话 11",
		},
		{
			name:             "崩溃推断超阈值触发",
			webhookEnabled:   true,
			errorSessions:    0,
			crashes:          3,
			expectNotified:   true,
			expectTextSubstr: "崩溃推断 3",
		},
		{
			name:             "双阈值同时触发合并成一条",
			webhookEnabled:   true,
			errorSessions:    20,
			crashes:          5,
			expectNotified:   true,
			expectTextSubstr: "、",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStore()
			store.monitorErrSessions = tc.errorSessions
			store.monitorKindCounts = map[string]int64{"CRASH_INFERRED": tc.crashes}

			var webhook string
			var capture *webhookCapture
			if tc.webhookEnabled {
				c, srv := newCaptureServer(t)
				capture = c
				webhook = srv.URL
			}

			RunMonitorAlertOnce(context.Background(), baseCfg(webhook), store)

			if !tc.expectNotified {
				if capture != nil {
					capture.mu.Lock()
					assert.Empty(t, capture.bodies, "不应推送告警")
					capture.mu.Unlock()
				}
				return
			}

			capture.mu.Lock()
			defer capture.mu.Unlock()
			require.Len(t, capture.bodies, 1, "应推送恰好一条告警")
			body := capture.bodies[0]
			assert.Contains(t, body["text"], tc.expectTextSubstr)
			assert.Equal(t, float64(tc.errorSessions), body["errorSessions"])
			assert.Equal(t, float64(tc.crashes), body["crashes"])
			assert.Equal(t, "1h", body["window"])
		})
	}

	t.Run("count 查询失败不推送且不 panic", func(t *testing.T) {
		store := newFakeStore()
		store.monitorCountErr = errors.New("db unavailable")
		capture, srv := newCaptureServer(t)

		RunMonitorAlertOnce(context.Background(), baseCfg(srv.URL), store)

		capture.mu.Lock()
		assert.Empty(t, capture.bodies, "查询失败不应推送告警")
		capture.mu.Unlock()
	})
}
