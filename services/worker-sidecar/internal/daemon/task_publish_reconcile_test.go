package daemon

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

// 🧪 发布扇出对账任务：表驱动验证出站调用契约（URL / 方法 / 内部令牌头 / 非传真行为）。
func TestRunPublishFanoutReconcileOnce(t *testing.T) {
	t.Helper()

	tests := []struct {
		name string
		cfg  Config
		// server 断言到达的请求；返回状态码
		wantPath  string
		wantToken string
		status    int
		wantSkip  bool // true = 期望不发任何请求（NODE_INTERNAL_URL 为空）
	}{
		{
			name:      "正常周期：POST 端点并携带共享内部令牌",
			cfg:       Config{NodeInternalURL: "WILL_BE_REPLACED", InternalToken: "secret-1"},
			wantPath:  "/api/tasks/publish-fanout-reconcile",
			wantToken: "secret-1",
			status:    http.StatusOK,
		},
		{
			name:      "Node 端点非 200：仅记日志不重试不 panic",
			cfg:       Config{NodeInternalURL: "WILL_BE_REPLACED", InternalToken: "secret-1"},
			wantPath:  "/api/tasks/publish-fanout-reconcile",
			wantToken: "secret-1",
			status:    http.StatusServiceUnavailable,
		},
		{
			name:     "NODE_INTERNAL_URL 未配置：本轮跳过（零出站请求）",
			cfg:      Config{InternalToken: "secret-1"},
			wantSkip: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				assert.Equal(t, tt.wantPath, r.URL.Path)
				assert.Equal(t, http.MethodPost, r.Method)
				assert.Equal(t, tt.wantToken, r.Header.Get("x-internal-token"))
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(`{"ok":true,"scanned":0}`))
			}))
			defer ts.Close()

			cfg := tt.cfg
			if !tt.wantSkip {
				cfg.NodeInternalURL = ts.URL
			}

			assert.NotPanics(t, func() {
				runPublishFanoutReconcileOnce(context.Background(), cfg)
			})
			assert.Equal(t, !tt.wantSkip, called)
		})
	}
}
