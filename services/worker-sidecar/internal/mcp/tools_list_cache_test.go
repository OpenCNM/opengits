package mcp

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

// 🧪 预序列化清单与逐请求 Encoder 输出字节级一致（双时代 × 三端点全锁定）
func TestPrecomputedListsByteCompatible(t *testing.T) {
	cases := []struct {
		name       string
		pre        precomputedList
		serverName string
	}{
		{"native", nativeToolsListCache, "opengits-mcp-sidecar"},
		{"hub", hubToolsListCache, "opengits-user-hub"},
		{"bundle", bundleToolsListCache, "opengits-mcp-bundle"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			for _, modern := range []bool{false, true} {
				era := eraInfo{Modern: modern, ServerName: tt.serverName}
				id := json.RawMessage(`42`)

				want := httptest.NewRecorder()
				res := ToolsListResult{Tools: NativeToolsList}
				if tt.name == "hub" {
					res = ToolsListResult{Tools: NativeHubToolsList}
				} else if tt.name == "bundle" {
					res = ToolsListResult{Tools: NativeBundleToolsList}
				}
				res.setModernEnvelope(era, true)
				writeJSONRPCResponse(want, id, res)

				got := httptest.NewRecorder()
				writePrecomputedList(got, id, era, tt.pre)

				assert.Equal(t, want.Body.String(), got.Body.String(), "modern=%v endpoint=%s 必须字节级一致", modern, tt.name)
				assert.True(t, bytes.HasSuffix(got.Body.Bytes(), []byte("}\n")), "必须保留 Encoder 的尾换行")
			}
		})
	}
}
