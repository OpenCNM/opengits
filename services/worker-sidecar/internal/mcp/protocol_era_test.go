package mcp

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 🧪 MCP 2026-07-28 双时代协议测试：
// modern（无状态 _meta 信封）与 legacy（initialize 握手）并存，
// legacy 响应字节级不变、modern 响应携带 resultType/_meta/ttlMs/cacheScope。

func modernBody(id int, method string, params string) string {
	meta := `"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}`
	if params != "" {
		params = strings.TrimSuffix(strings.TrimPrefix(params, "{"), "}") + ","
	}
	idStr, _ := json.Marshal(id)
	return `{"jsonrpc":"2.0","id":` + string(idStr) + `,"method":"` + method + `","params":{` + params + `"_meta":{` + meta + `}}}`
}

type eraResponse struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Result  struct {
		Tools        []ToolDefinition    `json:"tools"`
		Prompts      []PromptDefinition  `json:"prompts"`
		SupportedVer []string            `json:"supportedVersions"`
		ResultType   string              `json:"resultType"`
		TTLMs        int                 `json:"ttlMs"`
		CacheScope   string              `json:"cacheScope"`
		Meta         map[string]any      `json:"_meta"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func decodeEraResponse(t *testing.T, resp *http.Response) eraResponse {
	t.Helper()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	var out eraResponse
	require.NoError(t, json.Unmarshal(raw, &out), "body: %s", string(raw))
	return out
}

// 🧪 [2026-07-28] modern 时代协议面：list/discover 结果信封 + 删除方法语义 + 硬校验
func TestModernEraProtocolSurface(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	upstreamHit := false
	ts := readTestServer(t, store, &upstreamHit)

	tests := []struct {
		name          string
		path          string
		body          string
		wantStatus    int
		wantErrorCode int
		verify        func(t *testing.T, resp eraResponse)
	}{
		{
			name:       "tools/list 携带 resultType/ttlMs/cacheScope/_meta.serverInfo",
			path:       "/api/mcp/octo/kit",
			body:       modernBody(1, "tools/list", ""),
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, resp eraResponse) {
				assert.Len(t, resp.Result.Tools, 13)
				assert.Equal(t, "complete", resp.Result.ResultType)
				assert.Equal(t, modernListTTLMs, resp.Result.TTLMs)
				assert.Equal(t, "private", resp.Result.CacheScope)
				assert.Equal(t, map[string]any{
					"io.modelcontextprotocol/serverInfo": map[string]any{"name": "opengits-mcp-sidecar", "version": "1.0.0"},
				}, resp.Result.Meta)
			},
		},
		{
			name:       "prompts/list 携带 CacheableResult 信封（路由无关，不触达 Node）",
			path:       "/api/mcp/octo/kit",
			body:       modernBody(2, "prompts/list", ""),
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, resp eraResponse) {
				assert.Len(t, resp.Result.Prompts, 4)
				assert.Equal(t, "complete", resp.Result.ResultType)
				assert.Equal(t, modernListTTLMs, resp.Result.TTLMs)
			},
		},
		{
			name:       "server/discover 宣告 modern 版本",
			path:       "/api/mcp/octo/kit",
			body:       modernBody(3, "server/discover", ""),
			wantStatus: http.StatusOK,
			verify: func(t *testing.T, resp eraResponse) {
				assert.Equal(t, []string{modernProtocolVersion}, resp.Result.SupportedVer)
				assert.Equal(t, "complete", resp.Result.ResultType)
			},
		},
		{
			name:          "initialize 已被规范删除：modern 时代按未定义方法应答 -32601",
			path:          "/api/mcp/octo/kit",
			body:          modernBody(4, "initialize", `{"protocolVersion":"2026-07-28"}`),
			wantStatus:    http.StatusOK,
			wantErrorCode: -32601,
		},
		{
			name:          "ping 已被规范删除：modern 时代按未定义方法应答 -32601",
			path:          "/api/mcp/octo/kit",
			body:          modernBody(5, "ping", ""),
			wantStatus:    http.StatusOK,
			wantErrorCode: -32601,
		},
		{
			name:          "缺失必填 _meta.clientCapabilities：400 + -32602",
			path:          "/api/mcp/octo/kit",
			body:          `{"jsonrpc":"2.0","id":6,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`,
			wantStatus:    http.StatusBadRequest,
			wantErrorCode: -32602,
		},
		{
			name:          "不支持的更高版本声明：-32022 UnsupportedProtocolVersion",
			path:          "/api/mcp/octo/kit",
			body:          `{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2027-03-01","io.modelcontextprotocol/clientCapabilities":{}}}}`,
			wantStatus:    http.StatusBadRequest,
			wantErrorCode: -32022,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := post(t, ts.URL+tt.path, goodToken, tt.body)
			defer resp.Body.Close()
			assert.Equal(t, tt.wantStatus, resp.StatusCode)
			decoded := decodeEraResponse(t, resp)
			if tt.wantErrorCode != 0 {
				require.NotNil(t, decoded.Error)
				assert.Equal(t, tt.wantErrorCode, decoded.Error.Code)
			}
			if tt.verify != nil {
				require.Nil(t, decoded.Error)
				tt.verify(t, decoded)
			}
		})
	}

	assert.False(t, upstreamHit, "modern 协议面全部由 Go 原生承接，不得触达 Node")
	assert.Zero(t, store.fakeStore.increments, "协议级方法免计量")
}

// 🧪 [2026-07-28] legacy 时代零漂移：initialize 协商 + 响应不含 modern 信封字段
func TestLegacyEraNegotiationAndByteCompatibility(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	upstreamHit := false
	ts := readTestServer(t, store, &upstreamHit)

	tests := []struct {
		name          string
		requested     string
		wantNegotiated string
	}{
		{name: "回显受支持的客户端版本 2025-06-18", requested: `"2025-06-18"`, wantNegotiated: "2025-06-18"},
		{name: "回显 2024-11-05（历史行为保持）", requested: `"2024-11-05"`, wantNegotiated: "2024-11-05"},
		{name: "不可识别版本回落最新受支持版本", requested: `"1999-01-01"`, wantNegotiated: "2025-11-25"},
		{name: "缺失版本声明回落最新受支持版本", requested: ``, wantNegotiated: "2025-11-25"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			versionField := ""
			if tt.requested != "" {
				versionField = `"protocolVersion":` + tt.requested + `,`
			}
			body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{` + versionField + `"capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`
			resp := post(t, ts.URL+"/api/mcp/octo/kit", goodToken, body)
			defer resp.Body.Close()
			assert.Equal(t, http.StatusOK, resp.StatusCode)
			var decoded struct {
				Result InitializeResult `json:"result"`
			}
			require.NoError(t, json.Unmarshal([]byte(readAll(t, resp.Body)), &decoded))
			assert.Equal(t, tt.wantNegotiated, decoded.Result.ProtocolVersion)
			assert.Equal(t, "opengits-mcp-sidecar", decoded.Result.ServerInfo.Name)
		})
	}

	// legacy tools/list / prompts/list 不携带任何 modern 信封字段（旧客户端零漂移）
	for _, method := range []string{"tools/list", "prompts/list"} {
		t.Run("legacy "+method+" 无 modern 信封字段", func(t *testing.T) {
			resp := post(t, ts.URL+"/api/mcp/octo/kit", goodToken, `{"jsonrpc":"2.0","id":2,"method":"`+method+`","params":{}}`)
			defer resp.Body.Close()
			raw := readAll(t, resp.Body)
			assert.NotContains(t, raw, "resultType", "legacy 响应不得出现 modern 字段")
			assert.NotContains(t, raw, "ttlMs")
			assert.NotContains(t, raw, "cacheScope")
			assert.NotContains(t, raw, "_meta")
			assert.NotContains(t, raw, "io.modelcontextprotocol")
		})
	}
}

// 🧪 [2026-07-28] writeCallToolResult 双时代信封：legacy 字节级兼容 + modern 增强
func TestWriteCallToolResultDualEra(t *testing.T) {
	tests := []struct {
		name    string
		era     eraInfo
		isError bool
		want    string
	}{
		{
			name: "legacy 成功结果与历史 Fprintf 拼接字节级一致",
			era:  eraInfo{ServerName: "opengits-mcp-sidecar"},
			want: `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hi"}]}}`,
		},
		{
			name:    "legacy 错误结果携带 isError",
			era:     eraInfo{ServerName: "opengits-mcp-sidecar"},
			isError: true,
			want:    `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"boom"}],"isError":true}}`,
		},
		{
			name: "modern 成功结果附 resultType 与 _meta.serverInfo（非 Cacheable，无 ttlMs）",
			era:  eraInfo{Modern: true, ServerName: "opengits-mcp-sidecar"},
			want: `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hi"}],"resultType":"complete","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"opengits-mcp-sidecar","version":"1.0.0"}}}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			result := readResult{Text: "hi", IsError: tt.isError}
			if tt.isError {
				result.Text = "boom"
			}
			writeCallToolResult(rec, json.RawMessage(`1`), result, tt.era)
			assert.Equal(t, http.StatusOK, rec.Code)
			// writeJSONRPCResponse 经 json.Encoder 输出（含换行符），比对前 TrimSpace
			assert.Equal(t, tt.want, strings.TrimSpace(rec.Body.String()))
		})
	}
}

// 🧪 detectEra 纯函数：body 优先的时代判定边界
func TestDetectEra(t *testing.T) {
	tests := []struct {
		name       string
		meta       string
		wantModern bool
	}{
		{name: "无 _meta", meta: ``, wantModern: false},
		{name: "modern 版本声明", meta: `{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}`, wantModern: true},
		{name: "legacy 版本声明回退旧路由", meta: `{"io.modelcontextprotocol/protocolVersion":"2025-06-18"}`, wantModern: false},
		{name: "声明非字符串（malformed）回退旧路由", meta: `{"io.modelcontextprotocol/protocolVersion":42}`, wantModern: false},
		{name: "空字符串声明回退旧路由", meta: `{"io.modelcontextprotocol/protocolVersion":""}`, wantModern: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var meta map[string]json.RawMessage
			if tt.meta != "" {
				require.NoError(t, json.Unmarshal([]byte(tt.meta), &meta))
			}
			assert.Equal(t, tt.wantModern, detectEra(meta).Modern)
		})
	}
}

// 🧪 server/discover 免计量且对 legacy 客户端同样可答（兼容性探测）
func TestServerDiscoverFreeMethodAndLegacyFriendly(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	upstreamHit := false
	ts := readTestServer(t, store, &upstreamHit)

	// legacy 形态（无 _meta 版本声明）调用 server/discover 同样获得原生应答
	resp := post(t, ts.URL+"/api/mcp/octo/kit", goodToken, `{"jsonrpc":"2.0","id":9,"method":"server/discover","params":{}}`)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	decoded := decodeEraResponse(t, resp)
	require.Nil(t, decoded.Error)
	assert.Equal(t, []string{modernProtocolVersion}, decoded.Result.SupportedVer)

	assert.False(t, upstreamHit, "server/discover 必须原生应答")
	assert.Zero(t, store.fakeStore.increments, "server/discover 属协议发现面，免计量")
}
